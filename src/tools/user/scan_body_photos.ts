/**
 * MCP Tool: scan_body_photos
 * Scope: health:write
 *
 * A body scan from photos the person dropped into the chat. Wrapper only: the consent
 * check, the 18 and over rule, the scan allowance, the analysis and the save all live
 * on the Pelaris server (the core `scan_body_photos` tool over the coreToolsBridge),
 * and they are the same ones the Pelaris app uses.
 *
 * What this file owns:
 *  - reading the file references the host passes (`_meta["openai/fileParams"]`);
 *  - asking the server whether this person can scan BEFORE any photo is fetched;
 *  - fetching each photo once, into memory, under a strict guard (https, an allow-listed
 *    host, no redirects, a size cap, a time limit);
 *  - preparing each photo the way the Pelaris app does before it uploads (turned
 *    upright, long edge 1024 px, JPEG, no metadata), so a full-size phone photo works;
 *  - wording each outcome and adding a link into Pelaris where the next step is there.
 *
 * Photos are never stored, never written to disk and never logged, and neither are
 * their download links. A host that passes no file (or a client without file
 * parameters) gets the link to the scan screen instead.
 *
 * This tool stands alone on purpose: one file and one registration line, so it can be
 * held back without touching any other tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { hasScope } from "../../auth.js";
import { getRequestAuth } from "../../request-context.js";
import { scrubDocument } from "../../scrubber.js";
import { logToolCall, generateRequestId } from "../../logger.js";
import { callCoreBridge, type BridgeResult } from "../shared/bridge_client.js";
import { mintSignedEntryLink, type HandoffRoute } from "../shared/entry_links.js";

export const SCAN_BODY_PHOTOS_TOOL = "scan_body_photos";

/** The server's per-photo cap (bytes). A prepared photo over it is refused there, so it is refused here first. */
export const MAX_PHOTO_BYTES = 900_000;
/** The largest file fetched from the host (bytes), before it is prepared. */
export const MAX_DOWNLOAD_BYTES = 20_000_000;
/** The long edge a photo is scaled down to, the same as the Pelaris app's upload. */
export const PHOTO_LONG_EDGE_PX = 1024;
/** The largest image that is decoded (pixels). */
export const MAX_INPUT_PIXELS = 80_000_000;
const JPEG_QUALITIES: readonly number[] = [85, 70, 55];

// Photos are held only for the length of one call: no decoded image is kept between calls.
sharp.cache(false);
sharp.concurrency(1);

/**
 * Prepare one photo for the scan, as the Pelaris app does on the phone: turned upright
 * from its orientation tag, scaled so the long edge is at most 1024 px (never enlarged),
 * written as a JPEG with no metadata. Returns null when the bytes are not an image that
 * can be read, or it cannot be brought under the cap. In memory only.
 */
export async function preparePhoto(bytes: Buffer): Promise<Buffer | null> {
  try {
    for (const quality of JPEG_QUALITIES) {
      const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
        .rotate()
        .resize({ width: PHOTO_LONG_EDGE_PX, height: PHOTO_LONG_EDGE_PX, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: false })
        .toBuffer();
      if (out.length <= MAX_PHOTO_BYTES) return out;
    }
    return null;
  } catch {
    return null;
  }
}
export const PHOTO_FETCH_TIMEOUT_MS = 15_000;

/** Hosts a file reference may point at. Any other host is refused. */
export const ALLOWED_FILE_HOST_SUFFIXES: readonly string[] = ["oaiusercontent.com", "openai.com"];

export const SCAN_BODY_PHOTOS_DESCRIPTION =
  "Run a Pelaris body scan from photos the athlete has added to this chat: a front photo, " +
  "and a side photo when they have one, standing, head to feet in the frame, in good light. " +
  "Pelaris estimates their measurements and body shape and saves the scan to their Pelaris " +
  "history, where they can see their figure and their change over time. Use it when the " +
  "athlete shares body photos and asks for a scan, a body check-in or their measurements. " +
  "Photo scans are for adults (18 and over). The photos are analysed and not stored. A scan " +
  "uses the athlete's Pelaris scan allowance, the same one the app uses. If body scans are not " +
  "turned on in Pelaris yet, or the photos cannot be read, the result carries a message and a " +
  "link instead of measurements.";

/**
 * One file as the host passes it. All four properties are declared, as the Apps SDK asks.
 * A function, not a shared constant: each photo parameter needs its own copy, or the JSON
 * schema turns the second one into a bare $ref with no type.
 */
export const fileRefSchema = () =>
  z
    .object({
      download_url: z.string().describe("A short-lived link to the file, supplied by the host."),
      file_id: z.string().describe("The host's id for the file."),
      mime_type: z.string().optional().describe("The file's media type, when the host gives one."),
      file_name: z.string().optional().describe("The file's name, when the host gives one."),
    })
    .describe("A photo the athlete added to the chat.");

export type ScanOutcomeStatus =
  | "scanned"
  | "open_in_pelaris"
  | "consent_required"
  | "birth_year_required"
  | "age_restricted"
  | "allowance_spent"
  | "busy"
  | "photo_not_usable"
  | "retake"
  | "still_saving";

export interface ScanReply {
  status: ScanOutcomeStatus;
  message: string;
  link?: string;
  analysis?: unknown;
  renews_at?: string | null;
}

/** Which Pelaris screen each outcome links to (never Plans or checkout). */
export const OUTCOME_LINK_ROUTE: Readonly<Record<ScanOutcomeStatus, HandoffRoute | null>> = {
  scanned: "body",
  open_in_pelaris: "scan",
  consent_required: "scan",
  birth_year_required: "scan",
  age_restricted: "body",
  allowance_spent: "body",
  busy: null,
  photo_not_usable: "scan",
  retake: null,
  still_saving: "body",
};

const MESSAGES = {
  scanned: "Your scan is saved to your Pelaris history. Your photos were analysed and not stored. Open Pelaris to see your figure.",
  open_in_pelaris: "Take your body scan in Pelaris with this link. It takes about a minute and your photos are not stored.",
  consent_required: "Body scans are turned on once in Pelaris, where you can read how your photos are handled. Open this link, turn scans on and take your scan there.",
  birth_year_required: "Photo scans are for adults, so Pelaris needs your birth year first. Add it on the scan screen with this link.",
  age_restricted: "Photo scans are for 18 and over. You can still add your measurements by hand or upload your results in Pelaris.",
  busy: "The scan is busy right now. Give it a minute and try again.",
  photo_not_usable: "Pelaris could not read this photo from the chat. Take the scan in Pelaris with this link, and your photos will work there.",
  retake: "Pelaris couldn't read these photos clearly. Good light, head to feet in the frame, and try again.",
  still_saving: "Your scan is taking longer than usual and may still be saving. Open Pelaris with this link to see it, and only scan again if it is not there.",
} as const;

/**
 * The scan step's wait: the analysis and the save run in one server call, which the server
 * allows 180 s. A little under that, so the server's own answer arrives first when it can.
 */
export const SCAN_BRIDGE_TIMEOUT_MS = 175_000;

/** A file reference the host passed, or null (absent, a bare string, or the wrong shape). Never throws. */
export function readFileRef(raw: unknown): { downloadUrl: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const url = (raw as { download_url?: unknown }).download_url;
  return typeof url === "string" && url.length > 0 ? { downloadUrl: url } : null;
}

/** The host of a download link when it may be fetched, else why not. Pure. */
export function checkDownloadUrl(raw: string): { ok: true; url: URL } | { ok: false; code: "bad_url" | "not_https" | "host_not_allowed"; host?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "bad_url" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, code: "bad_url" };
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_FILE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) return { ok: false, code: "host_not_allowed", host: host.split(".").slice(-2).join(".") };
  return { ok: true, url };
}

export type PhotoFetchFailure =
  | "bad_url"
  | "not_https"
  | "host_not_allowed"
  | "redirected"
  | "http_error"
  | "too_large"
  | "not_image"
  | "timeout"
  | "network";

export type PhotoFetchResult = { ok: true; base64: string } | { ok: false; code: PhotoFetchFailure; host?: string };

/**
 * Fetch one photo into memory. https and an allow-listed host only, no redirect is
 * followed, the body is cut off past the cap, and the bytes must be an image that can
 * be prepared for the scan. Nothing is written anywhere.
 */
export async function fetchPhoto(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<PhotoFetchResult> {
  const checked = checkDownloadUrl(rawUrl);
  if (!checked.ok) return checked;
  let response: Response;
  try {
    response = await fetchImpl(checked.url, { redirect: "manual", signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, code: (error as Error).name === "TimeoutError" ? "timeout" : "network" };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, code: "redirected" };
  if (!response.ok || !response.body) return { ok: false, code: "http_error" };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, code: "too_large" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, code: (error as Error).name === "TimeoutError" ? "timeout" : "network" };
  }
  const prepared = await preparePhoto(Buffer.concat(chunks, total));
  if (prepared == null) return { ok: false, code: "not_image" };
  return { ok: true, base64: prepared.toString("base64") };
}

/** The server's closed outcome as the reply the assistant relays. Pure (the link is added by the caller). */
export function replyForOutcome(result: Record<string, unknown>): ScanReply {
  const outcome = typeof result.outcome === "string" ? result.outcome : "";
  const serverMessage = typeof result.message === "string" && result.message.length > 0 ? result.message : null;
  switch (outcome) {
    case "scanned":
      return { status: "scanned", message: MESSAGES.scanned, analysis: result.analysis };
    case "consent_required":
      return { status: "consent_required", message: MESSAGES.consent_required };
    case "birth_year_required":
      return { status: "birth_year_required", message: MESSAGES.birth_year_required };
    case "age_restricted":
      return { status: "age_restricted", message: MESSAGES.age_restricted };
    case "allowance_spent":
      return {
        status: "allowance_spent",
        message: serverMessage ?? "Your scan allowance is used for now.",
        renews_at: typeof result.renews_at === "string" ? result.renews_at : null,
      };
    case "photo_invalid":
      return { status: "photo_not_usable", message: MESSAGES.photo_not_usable };
    case "retake":
      return { status: "retake", message: serverMessage ?? MESSAGES.retake };
    default:
      return { status: "busy", message: MESSAGES.busy };
  }
}

type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface ScanBodyPhotosParams {
  front_photo?: unknown;
  side_photo?: unknown;
}

export interface ScanBodyPhotosDeps {
  bridge: (
    tool: string,
    profileId: string,
    input: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<BridgeResult>;
  fetchImpl: typeof fetch;
  mintLink: typeof mintSignedEntryLink;
}

const defaultDeps: ScanBodyPhotosDeps = { bridge: callCoreBridge, fetchImpl: fetch, mintLink: mintSignedEntryLink };

export function registerScanBodyPhotos(server: McpServer, deps: ScanBodyPhotosDeps = defaultDeps): void {
  server.registerTool(
    "scan_body_photos",
    {
      title: "Body Scan From Photos",
      description: SCAN_BODY_PHOTOS_DESCRIPTION,
      inputSchema: {
        front_photo: fileRefSchema().optional().describe("The athlete's front photo, standing, head to feet."),
        side_photo: fileRefSchema().optional().describe("The athlete's side photo, when they added one."),
      },
      annotations: {
        // Saves a scan to the athlete's history and uses their scan allowance.
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        title: "Body Scan From Photos",
      },
      _meta: { "openai/fileParams": ["front_photo", "side_photo"] },
    },
    async (params: ScanBodyPhotosParams): Promise<Reply> => {
      const requestId = generateRequestId();
      const start = Date.now();
      const claims = getRequestAuth();
      const log = (success: boolean, outcome: string, extras: Record<string, unknown> = {}): void => {
        // Closed words only: never a link, a file name or an error's own text.
        logToolCall({
          requestId,
          tool: SCAN_BODY_PHOTOS_TOOL,
          userPseudonym: claims?.sub,
          latencyMs: Date.now() - start,
          success,
          ...(success ? {} : { error: outcome }),
          extras: { outcome, ...extras },
        });
      };
      const answer = async (reply: ScanReply): Promise<Reply> => {
        const route = OUTCOME_LINK_ROUTE[reply.status];
        const link = route ? await deps.mintLink(route, claims) : undefined;
        const body = link ? { ...reply, link } : reply;
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      };

      try {
        if (!claims || !hasScope(claims.scope, "health:write")) {
          return { content: [{ type: "text" as const, text: "Error: health:write scope required" }], isError: true };
        }

        const front = readFileRef(params.front_photo);
        const side = readFileRef(params.side_photo);
        if (!front) {
          // No file reached the tool (a client without file parameters, or no photo added).
          log(true, "no_file");
          return answer({ status: "open_in_pelaris", message: MESSAGES.open_in_pelaris });
        }

        // The gates first: a person who cannot scan never has a photo fetched.
        const gate = await deps.bridge(SCAN_BODY_PHOTOS_TOOL, claims.profile_id, { mode: "check" });
        if (!gate.ok || gate.result == null) {
          log(false, "bridge_failed");
          return answer({ status: "busy", message: MESSAGES.busy });
        }
        const gateOutcome = (gate.result as { outcome?: unknown }).outcome;
        if (gateOutcome !== "ready") {
          const reply = replyForOutcome(gate.result as Record<string, unknown>);
          log(true, reply.status);
          return answer(reply);
        }

        const photos: string[] = [];
        for (const ref of side ? [front, side] : [front]) {
          const fetched = await fetchPhoto(ref.downloadUrl, deps.fetchImpl);
          if (!fetched.ok) {
            log(false, `photo_${fetched.code}`, fetched.host ? { file_host: fetched.host } : {});
            return answer({ status: "photo_not_usable", message: MESSAGES.photo_not_usable });
          }
          photos.push(fetched.base64);
        }

        // The scan step may be charged and saved on the server even when the wait runs out here,
        // so a wait that runs out never says "try again": it sends the athlete to see it in Pelaris.
        let scanned: BridgeResult;
        try {
          scanned = await deps.bridge(
            SCAN_BODY_PHOTOS_TOOL, claims.profile_id, { mode: "scan", photos }, { timeoutMs: SCAN_BRIDGE_TIMEOUT_MS },
          );
        } catch {
          log(false, "scan_wait_ran_out");
          return answer({ status: "still_saving", message: MESSAGES.still_saving });
        }
        if (!scanned.ok || scanned.result == null) {
          log(false, "bridge_failed");
          return answer({ status: "busy", message: MESSAGES.busy });
        }
        const result = scanned.result as Record<string, unknown>;
        const reply = replyForOutcome(
          result.outcome === "scanned" ? { ...result, analysis: scrubDocument(result.analysis as Record<string, unknown>) } : result,
        );
        log(true, reply.status);
        return answer(reply);
      } catch {
        log(false, "unexpected");
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "busy", message: MESSAGES.busy }, null, 2) }] };
      }
    },
  );
}
