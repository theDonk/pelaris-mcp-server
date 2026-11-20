/**
 * Tests for the scan_body_photos MCP tool (node:test). Run after build.
 *
 * The bridge, the photo fetch and the link maker are injected. Proves: the tool's
 * meta and scope; no file means a link and no fetch; the server's gate is asked
 * before any photo is fetched; the download guard (https, host, redirect, size,
 * type); each server outcome's wording and link; and that no link or photo byte
 * reaches the result or the logs.
 */

import sharp from "sharp";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpTokenClaims } from "../../../auth.js";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const {
  ALLOWED_FILE_HOST_SUFFIXES,
  MAX_PHOTO_BYTES,
  MAX_DOWNLOAD_BYTES,
  PHOTO_LONG_EDGE_PX,
  preparePhoto,
  OUTCOME_LINK_ROUTE,
  SCAN_BODY_PHOTOS_DESCRIPTION,
  checkDownloadUrl,
  fetchPhoto,
  readFileRef,
  registerScanBodyPhotos,
  replyForOutcome,
} = await import("../scan_body_photos.js");
const { runWithAuth } = await import("../../../request-context.js");

const claims: McpTokenClaims = {
  sub: "pseudonym_test",
  scope: "health:write",
  platform: "test",
  profile_id: "profile_test_1",
  exp: 0,
  iat: 0,
};

const FRONT_URL = "https://files.oaiusercontent.com/file-front?sig=SECRETSIGNATURE";
const SIDE_URL = "https://files.oaiusercontent.com/file-side?sig=SECRETSIGNATURE";
/** A real image of random pixels (random pixels compress badly, like a detailed photo). */
function noise(width: number, height: number, seed = 7): ReturnType<typeof sharp> {
  const raw = Buffer.alloc(width * height * 3);
  let x = seed;
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = x >> 16;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}
const JPEG = await noise(300, 400).jpeg({ quality: 90 }).toBuffer();
/** Bytes that only look like a picture: a PNG header and nothing behind it. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("PHOTOBYTES".repeat(20))]);
const PREPARED = (await preparePhoto(JPEG)) as Buffer;

type Reply = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (params: Record<string, unknown>) => Promise<Reply>;

function fetchOf(body: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const impl = (async (input: URL | string, options?: RequestInit) => {
    calls.push(String(input));
    assert.equal(options?.redirect, "manual");
    return new Response(init.status && init.status >= 300 && init.status < 400 ? null : new Uint8Array(body), {
      status: init.status ?? 200,
      headers: init.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function setup(options: {
  outcomes?: Array<Record<string, unknown> | "fail">;
  fetchImpl?: typeof fetch;
}) {
  const bridgeCalls: Array<{ tool: string; profileId: string; input: Record<string, unknown> }> = [];
  const queue = [...(options.outcomes ?? [])];
  const minted: string[] = [];
  let config: Record<string, unknown> = {};
  let handler: Handler | null = null;
  const fakeServer = {
    registerTool: (_name: string, c: Record<string, unknown>, h: unknown) => {
      config = c;
      handler = h as Handler;
    },
  };
  registerScanBodyPhotos(fakeServer as unknown as Parameters<typeof registerScanBodyPhotos>[0], {
    bridge: async (tool, profileId, input) => {
      bridgeCalls.push({ tool, profileId, input });
      const next = queue.shift();
      if (next === undefined || next === "fail") return { ok: false, tool, error: "down" };
      return { ok: true, tool, result: next };
    },
    fetchImpl: options.fetchImpl ?? fetchOf(JPEG).impl,
    mintLink: async (route) => {
      minted.push(route);
      return `https://coach.pelaris.io/start/${route}?h=test`;
    },
  });
  assert.ok(handler);
  const call = (params: Record<string, unknown>, as: McpTokenClaims = claims) =>
    runWithAuth(as, () => (handler as Handler)(params));
  return { config, call, bridgeCalls, minted };
}

function captureStdout<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  return fn().then(
    (value) => {
      process.stdout.write = original;
      return { value, out };
    },
    (error) => {
      process.stdout.write = original;
      throw error;
    },
  );
}

const file = (download_url: string) => ({ download_url, file_id: "file_1", mime_type: "image/jpeg", file_name: "a.jpg" });

test("the tool declares its file parameters, is not read-only, and has plain copy", () => {
  const { config } = setup({});
  assert.deepEqual((config._meta as Record<string, unknown>)["openai/fileParams"], ["front_photo", "side_photo"]);
  const annotations = config.annotations as Record<string, unknown>;
  assert.equal(annotations.readOnlyHint, false);
  assert.equal(annotations.destructiveHint, false);
  assert.ok(!SCAN_BODY_PHOTOS_DESCRIPTION.includes("—"));
  assert.match(SCAN_BODY_PHOTOS_DESCRIPTION, /18 and over/);
  assert.match(SCAN_BODY_PHOTOS_DESCRIPTION, /not stored/);
});

test("the scope is health:write", async () => {
  const { call, bridgeCalls } = setup({});
  const reply = await call({ front_photo: file(FRONT_URL) }, { ...claims, scope: "training:read" });
  assert.equal(reply.isError, true);
  assert.equal(bridgeCalls.length, 0);
});

test("no file, or a bare string, answers with the scan link and fetches nothing", async () => {
  for (const params of [{}, { front_photo: "a photo" }, { front_photo: { file_id: "x" } }]) {
    const fetcher = fetchOf(JPEG);
    const { call, bridgeCalls, minted } = setup({ fetchImpl: fetcher.impl });
    const body = JSON.parse((await call(params)).content[0].text);
    assert.equal(body.status, "open_in_pelaris");
    assert.equal(body.link, "https://coach.pelaris.io/start/scan?h=test");
    assert.deepEqual(minted, ["scan"]);
    assert.equal(bridgeCalls.length, 0);
    assert.equal(fetcher.calls.length, 0);
  }
});

test("the server's gate is asked first, and a refusal fetches no photo", async () => {
  for (const [outcome, status, route] of [
    ["consent_required", "consent_required", "scan"],
    ["birth_year_required", "birth_year_required", "scan"],
    ["age_restricted", "age_restricted", "body"],
  ] as const) {
    const fetcher = fetchOf(JPEG);
    const { call, bridgeCalls, minted } = setup({ outcomes: [{ outcome }], fetchImpl: fetcher.impl });
    const body = JSON.parse((await call({ front_photo: file(FRONT_URL) })).content[0].text);
    assert.equal(body.status, status);
    assert.deepEqual(minted, [route]);
    assert.deepEqual(bridgeCalls.map((c) => c.input), [{ mode: "check" }]);
    assert.equal(fetcher.calls.length, 0);
  }
});

test("a spent allowance keeps the server's own words", async () => {
  const { call } = setup({
    outcomes: [{ outcome: "allowance_spent", message: "Your next scan unlocks on Sat 5 Dec.", renews_at: "2026-12-05T00:00:00.000Z" }],
  });
  const body = JSON.parse((await call({ front_photo: file(FRONT_URL) })).content[0].text);
  assert.equal(body.status, "allowance_spent");
  assert.equal(body.message, "Your next scan unlocks on Sat 5 Dec.");
  assert.equal(body.renews_at, "2026-12-05T00:00:00.000Z");
});

test("a scan sends front then side to the server and returns the saved reading", async () => {
  const fetcher = fetchOf(JPEG);
  const { call, bridgeCalls, minted } = setup({
    outcomes: [{ outcome: "ready" }, { outcome: "scanned", entryId: "e1", analysis: { hasAnalysis: true, latest: { waistCm: 82 } } }],
    fetchImpl: fetcher.impl,
  });
  const { value, out } = await captureStdout(() => call({ front_photo: file(FRONT_URL), side_photo: file(SIDE_URL) }));
  const text = value.content[0].text;
  const body = JSON.parse(text);
  assert.equal(body.status, "scanned");
  assert.deepEqual(body.analysis, { hasAnalysis: true, latest: { waistCm: 82 } });
  assert.deepEqual(minted, ["body"]);
  assert.deepEqual(fetcher.calls, [FRONT_URL, SIDE_URL]);
  assert.equal(bridgeCalls[1].profileId, "profile_test_1");
  assert.equal(bridgeCalls[1].input.mode, "scan");
  assert.deepEqual(bridgeCalls[1].input.photos, [PREPARED.toString("base64"), PREPARED.toString("base64")]);
  // Nothing photo-shaped in the result or the logs: no link, no signature, no bytes.
  for (const leak of ["oaiusercontent", "SECRETSIGNATURE", JPEG.toString("base64").slice(0, 40), PREPARED.toString("base64").slice(0, 40)]) {
    assert.ok(!text.includes(leak), `result leaks ${leak}`);
    assert.ok(!out.includes(leak), `log leaks ${leak}`);
  }
  assert.match(out, /"outcome":"scanned"/);
});

test("the download guard: https, an allowed host, no redirect, size and type", async () => {
  assert.ok(ALLOWED_FILE_HOST_SUFFIXES.length > 0);
  assert.deepEqual(checkDownloadUrl("not a url"), { ok: false, code: "bad_url" });
  assert.deepEqual(checkDownloadUrl("http://files.oaiusercontent.com/a"), { ok: false, code: "not_https" });
  assert.deepEqual(checkDownloadUrl("https://user:pw@files.oaiusercontent.com/a"), { ok: false, code: "bad_url" });
  assert.deepEqual(checkDownloadUrl("https://example.com/a?x=1"), { ok: false, code: "host_not_allowed", host: "example.com" });
  assert.deepEqual(checkDownloadUrl("https://evil-oaiusercontent.com/a"), { ok: false, code: "host_not_allowed", host: "evil-oaiusercontent.com" });
  assert.deepEqual(checkDownloadUrl("https://oaiusercontent.com.example.org/a"), { ok: false, code: "host_not_allowed", host: "example.org" });
  assert.deepEqual(checkDownloadUrl("https://169.254.169.254/latest"), { ok: false, code: "host_not_allowed", host: "169.254" });
  assert.equal(checkDownloadUrl(FRONT_URL).ok, true);

  const never = fetchOf(JPEG);
  assert.equal((await fetchPhoto("https://example.com/a", never.impl)).ok, false);
  assert.equal(never.calls.length, 0);

  assert.deepEqual(await fetchPhoto(FRONT_URL, fetchOf(JPEG, { status: 302, headers: { location: "https://example.com/" } }).impl), { ok: false, code: "redirected" });
  assert.deepEqual(await fetchPhoto(FRONT_URL, fetchOf(JPEG, { status: 404 }).impl), { ok: false, code: "http_error" });
  assert.deepEqual(await fetchPhoto(FRONT_URL, fetchOf(PNG).impl), { ok: false, code: "not_image" });
  assert.deepEqual(
    await fetchPhoto(FRONT_URL, fetchOf(JPEG, { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } }).impl),
    { ok: false, code: "too_large" },
  );
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_DOWNLOAD_BYTES)]);
  assert.deepEqual(await fetchPhoto(FRONT_URL, fetchOf(big).impl), { ok: false, code: "too_large" });
  const failing = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchPhoto(FRONT_URL, failing), { ok: false, code: "network" });
  assert.deepEqual(await fetchPhoto(FRONT_URL, fetchOf(JPEG).impl), { ok: true, base64: PREPARED.toString("base64") });
});

test("a full-size phone photo is prepared like the app's upload: upright, 1024 px long edge, JPEG, no metadata", async () => {
  // Far over the server's cap as it arrives, and tagged as taken on its side with a place attached.
  const phone = await noise(3000, 2250)
    .jpeg({ quality: 92 })
    .withExif({ IFD0: { Make: "TestPhone" }, IFD3: { GPSLatitudeRef: "N" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  assert.ok(phone.length > MAX_PHOTO_BYTES, "the fixture must be over the cap");
  const fetched = await fetchPhoto(FRONT_URL, fetchOf(phone).impl);
  assert.equal(fetched.ok, true);
  if (!fetched.ok) return;
  const out = Buffer.from(fetched.base64, "base64");
  assert.ok(out.length <= MAX_PHOTO_BYTES);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "jpeg");
  // Turned upright: the landscape frame tagged "rotate 90" comes out portrait.
  assert.equal(meta.height, PHOTO_LONG_EDGE_PX);
  assert.equal(meta.width, 768);
  assert.equal(meta.exif, undefined);
  assert.ok(meta.orientation === undefined || meta.orientation === 1);

  // Other photo formats are read too, a small photo is never enlarged, and noise is not a photo.
  const png = await preparePhoto(await noise(200, 300).png().toBuffer());
  const pngMeta = await sharp(png as Buffer).metadata();
  assert.deepEqual([pngMeta.format, pngMeta.width, pngMeta.height], ["jpeg", 200, 300]);
  const webp = await preparePhoto(await noise(200, 300).webp().toBuffer());
  assert.equal((await sharp(webp as Buffer).metadata()).format, "jpeg");
  assert.equal(await preparePhoto(PNG), null);
  assert.equal(await preparePhoto(Buffer.alloc(0)), null);
});

test("a photo that cannot be used answers with the scan link and never reaches the server's scan", async () => {
  const { call, bridgeCalls, minted } = setup({ outcomes: [{ outcome: "ready" }], fetchImpl: fetchOf(PNG).impl });
  const { value, out } = await captureStdout(() => call({ front_photo: file("https://example.com/p.png?sig=SECRETSIGNATURE") }));
  const body = JSON.parse(value.content[0].text);
  assert.equal(body.status, "photo_not_usable");
  assert.deepEqual(minted, ["scan"]);
  assert.equal(bridgeCalls.length, 1);
  assert.match(out, /"outcome":"photo_host_not_allowed"/);
  assert.match(out, /"file_host":"example.com"/);
  assert.ok(!out.includes("SECRETSIGNATURE"));
  assert.ok(!out.includes("p.png"));
});

test("a server failure is a calm busy answer, not an error", async () => {
  const { call } = setup({ outcomes: ["fail"] });
  const reply = await call({ front_photo: file(FRONT_URL) });
  assert.notEqual(reply.isError, true);
  assert.equal(JSON.parse(reply.content[0].text).status, "busy");
});

test("pure helpers: file references, outcome wording, link routes", () => {
  assert.deepEqual(readFileRef(file(FRONT_URL)), { downloadUrl: FRONT_URL });
  assert.equal(readFileRef(null), null);
  assert.equal(readFileRef("x"), null);
  assert.equal(replyForOutcome({ outcome: "retake", message: "We couldn't analyse this photo." }).message, "We couldn't analyse this photo.");
  assert.equal(replyForOutcome({ outcome: "photo_invalid", reason: "too_large" }).status, "photo_not_usable");
  assert.equal(replyForOutcome({ outcome: "something_new" }).status, "busy");
  // No outcome ever links to plans or checkout.
  for (const route of Object.values(OUTCOME_LINK_ROUTE)) assert.ok(route === null || ["scan", "body"].includes(route));
  for (const reply of ["consent_required", "birth_year_required", "age_restricted", "busy"]) {
    assert.ok(!replyForOutcome({ outcome: reply }).message.includes("—"));
  }
});
