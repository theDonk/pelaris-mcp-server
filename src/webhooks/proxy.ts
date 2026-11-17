/**
 * Generic raw-body webhook proxy (`POST /webhooks/:provider`).
 *
 * Mounted BEFORE `express.json()` so inbound payload bytes reach the upstream
 * target unmodified (preserving byte-exact HMAC / signature verification).
 * Allowed providers and target URLs are driven strictly by configuration and
 * environment variables with no hardcoded project IDs or internal endpoints.
 */
import express, { type Express, type Request, type Response } from "express";

import { CLIENT_IP_HEADER, GATEWAY_SECRET_HEADER } from "../connector/client_ip.js";
import { log, type LogEntry } from "../logger.js";

export const DEFAULT_ALLOWED_WEBHOOK_PROVIDERS: readonly string[] = Object.freeze(["wahoo"]);
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_PROXY_TIMEOUT_MS = 15_000;

const MIN_PROXY_TIMEOUT_MS = 1_000;
const MAX_PROXY_TIMEOUT_MS = 60_000;
const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_PROXY_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-encoding",
  "expect",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  CLIENT_IP_HEADER,
  GATEWAY_SECRET_HEADER,
]);

export type TargetResolution =
  | { ok: true; url: URL }
  | { ok: false; reason: "missing_target" | "invalid_target" };

export interface WebhookProxyDeps {
  fetch: typeof fetch;
  env(): Record<string, string | undefined>;
  allowedProviders?: Iterable<string>;
  maxBodyBytes?: number | string;
  timeoutMs?: number;
  log(entry: LogEntry): void;
}

export function defaultWebhookProxyDeps(): WebhookProxyDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    env: () => process.env,
    log: (entry) => log(entry),
  };
}

export function normalizeProviderSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return PROVIDER_SLUG_PATTERN.test(normalized) ? normalized : null;
}

function normalizeProviderSet(providers: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const candidate of providers) {
    const slug = normalizeProviderSlug(candidate);
    if (slug) out.add(slug);
  }
  return out;
}

/**
 * Parse `WEBHOOK_ALLOWED_PROVIDERS` (comma-separated slugs). When unset,
 * defaults to `DEFAULT_ALLOWED_WEBHOOK_PROVIDERS`. An explicit empty string
 * allows zero providers (fail-closed).
 */
export function parseAllowedProviders(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set(DEFAULT_ALLOWED_WEBHOOK_PROVIDERS);
  return normalizeProviderSet(raw.split(","));
}

export function providerEnvKey(provider: string): string {
  return `WEBHOOK_TARGET_${provider.toUpperCase().replace(/-/g, "_")}`;
}

export function parseWebhookTargetsMap(
  raw: string | undefined,
  onInvalid?: () => void,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "string" || raw.trim() === "") return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      onInvalid?.();
      return out;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const slug = normalizeProviderSlug(key);
      if (slug && typeof value === "string" && value.trim().length > 0) {
        out.set(slug, value.trim());
      }
    }
    return out;
  } catch {
    onInvalid?.();
    return out;
  }
}

export function resolveWebhookTarget(
  provider: string,
  env: Record<string, string | undefined>,
  onInvalidTargetsJson?: () => void,
): TargetResolution {
  const perProviderRaw = env[providerEnvKey(provider)];
  const direct = typeof perProviderRaw === "string" ? perProviderRaw.trim() : "";
  const rawTarget = direct.length > 0
    ? direct
    : parseWebhookTargetsMap(env.WEBHOOK_TARGETS, onInvalidTargetsJson).get(provider) ?? "";

  if (rawTarget.length === 0) {
    return { ok: false, reason: "missing_target" };
  }

  try {
    const url = new URL(rawTarget);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, reason: "invalid_target" };
    }
    if (!url.hostname || url.username !== "" || url.password !== "") {
      return { ok: false, reason: "invalid_target" };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, reason: "invalid_target" };
  }
}

export function resolveTimeoutMs(raw: string | undefined): number {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_PROXY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROXY_TIMEOUT_MS;
  return Math.min(MAX_PROXY_TIMEOUT_MS, Math.max(MIN_PROXY_TIMEOUT_MS, Math.floor(parsed)));
}

/**
 * Append incoming query parameters to `target` without allowing inbound query
 * keys to overwrite parameters already configured on the target URL.
 */
export function buildUpstreamUrl(target: URL, originalUrl: string): string {
  const upstream = new URL(target.toString());
  upstream.hash = "";

  const qIndex = originalUrl.indexOf("?");
  if (qIndex < 0) return upstream.toString();

  const hashIndex = originalUrl.indexOf("#", qIndex);
  const rawQuery = hashIndex >= 0
    ? originalUrl.slice(qIndex + 1, hashIndex)
    : originalUrl.slice(qIndex + 1);
  if (rawQuery.length === 0) return upstream.toString();

  if (upstream.search === "") {
    return `${upstream.toString()}?${rawQuery}`;
  }

  const configuredKeys = new Set(upstream.searchParams.keys());
  const incoming = new URLSearchParams(rawQuery);
  for (const [key, value] of incoming.entries()) {
    if (!configuredKeys.has(key)) {
      upstream.searchParams.append(key, value);
    }
  }
  return upstream.toString();
}

export function buildOutboundHeaders(inbound: Request["headers"]): Record<string, string> {
  const dynamicHopHeaders = new Set<string>();
  const connectionRaw = inbound.connection;
  const connectionValue = Array.isArray(connectionRaw) ? connectionRaw.join(",") : connectionRaw;
  if (typeof connectionValue === "string") {
    for (const token of connectionValue.split(",")) {
      const name = token.trim().toLowerCase();
      if (name.length > 0) dynamicHopHeaders.add(name);
    }
  }

  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(inbound)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || STRIPPED_PROXY_HEADERS.has(key) || dynamicHopHeaders.has(key)) {
      continue;
    }
    if (typeof rawValue === "string") {
      headers[key] = rawValue;
    } else if (Array.isArray(rawValue) && rawValue.length > 0) {
      headers[key] = rawValue.join(", ");
    }
  }
  return headers;
}

function activeAllowedProviders(deps: WebhookProxyDeps, env: Record<string, string | undefined>): ReadonlySet<string> {
  return deps.allowedProviders !== undefined
    ? normalizeProviderSet(deps.allowedProviders)
    : parseAllowedProviders(env.WEBHOOK_ALLOWED_PROVIDERS);
}

function classifyRawBodyError(err: unknown): { status: number; error: string; description: string; reason: string } {
  const typed = err as { status?: unknown; statusCode?: unknown; type?: unknown } | null;
  const status = typeof typed?.status === "number"
    ? typed.status
    : (typeof typed?.statusCode === "number" ? typed.statusCode : 400);
  const type = typeof typed?.type === "string" ? typed.type : "";

  if (type === "entity.too.large" || status === 413) {
    return {
      status: 413,
      error: "payload_too_large",
      description: "Webhook payload exceeds size limit",
      reason: "payload_too_large",
    };
  }
  if (type === "encoding.unsupported" || type === "charset.unsupported" || status === 415) {
    return {
      status: 415,
      error: "unsupported_media_type",
      description: "Unsupported content encoding or charset",
      reason: "unsupported_media_type",
    };
  }
  return {
    status: status >= 400 && status < 500 ? status : 400,
    error: "invalid_request",
    description: "Invalid webhook request body",
    reason: "invalid_body",
  };
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

export function webhookProxyHandler(
  deps: WebhookProxyDeps = defaultWebhookProxyDeps(),
): (req: Request, res: Response) => void {
  // Capture exact wire bytes regardless of Content-Type (including omitted Content-Type).
  const rawParser = express.raw({
    type: () => true,
    limit: deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  });

  return (req, res) => {
    const started = Date.now();
    const env = deps.env();
    const provider = normalizeProviderSlug(req.params.provider);
    const allowed = activeAllowedProviders(deps, env);

    if (!provider || !allowed.has(provider)) {
      deps.log({
        severity: "WARN",
        message: "webhook_proxy",
        event: "webhook_proxy",
        provider: provider ?? "invalid",
        outcome: "rejected",
        reason: "unknown_provider",
        status: 404,
        latencyMs: Date.now() - started,
      });
      res.status(404).json({
        error: "unknown_provider",
        error_description: "Webhook provider is not enabled",
      });
      return;
    }

    const target = resolveWebhookTarget(provider, env, () => {
      deps.log({
        severity: "WARN",
        message: "webhook_config_invalid",
        event: "webhook_config_invalid",
        provider,
        reason: "invalid_webhook_targets_json",
      });
    });
    if (!target.ok) {
      deps.log({
        severity: "WARN",
        message: "webhook_proxy",
        event: "webhook_proxy",
        provider,
        outcome: "unconfigured",
        reason: target.reason,
        status: 503,
        latencyMs: Date.now() - started,
      });
      res.status(503).json({
        error: "webhook_not_configured",
        error_description: "Webhook target is not configured",
      });
      return;
    }

    rawParser(req, res, (parseErr?: unknown) => {
      void (async () => {
        if (parseErr) {
          const mapped = classifyRawBodyError(parseErr);
          deps.log({
            severity: "WARN",
            message: "webhook_proxy",
            event: "webhook_proxy",
            provider,
            outcome: "rejected",
            reason: mapped.reason,
            status: mapped.status,
            latencyMs: Date.now() - started,
          });
          if (!res.headersSent) {
            res.status(mapped.status).json({
              error: mapped.error,
              error_description: mapped.description,
            });
          }
          return;
        }

        const alreadyParsed = (req as Request & { _body?: boolean })._body === true;
        if (alreadyParsed && !Buffer.isBuffer(req.body)) {
          deps.log({
            severity: "ERROR",
            message: "webhook_proxy",
            event: "webhook_proxy",
            provider,
            outcome: "rejected",
            reason: "raw_body_unavailable",
            status: 500,
            latencyMs: Date.now() - started,
          });
          if (!res.headersSent) {
            res.status(500).json({
              error: "raw_body_unavailable",
              error_description: "Webhook proxy requires raw body capture before JSON parsing",
            });
          }
          return;
        }

        const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const upstreamUrl = buildUpstreamUrl(target.url, req.originalUrl || req.url || "");
        const outboundHeaders = buildOutboundHeaders(req.headers);
        const timeoutMs = deps.timeoutMs ?? resolveTimeoutMs(env.WEBHOOK_PROXY_TIMEOUT_MS);

        try {
          const upstream = await deps.fetch(upstreamUrl, {
            method: "POST",
            headers: outboundHeaders,
            body: rawBody as unknown as BodyInit,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (upstream.status >= 300 && upstream.status < 400) {
            deps.log({
              severity: "WARN",
              message: "webhook_proxy",
              event: "webhook_proxy",
              provider,
              outcome: "upstream_error",
              reason: "upstream_redirect",
              status: 502,
              upstreamStatus: upstream.status,
              bodyBytes: rawBody.byteLength,
              latencyMs: Date.now() - started,
            });
            if (!res.headersSent) {
              res.status(502).json({
                error: "proxy_error",
                error_description: "Upstream webhook target returned an unexpected redirect",
              });
            }
            return;
          }

          const contentType = upstream.headers.get("content-type");
          const retryAfter = upstream.headers.get("retry-after");
          const responseBuf = upstream.status === 204 || upstream.status === 304
            ? Buffer.alloc(0)
            : Buffer.from(await upstream.arrayBuffer());

          if (!res.headersSent) {
            if (contentType) res.setHeader("Content-Type", contentType);
            if (retryAfter) res.setHeader("Retry-After", retryAfter);
            if (upstream.status === 204 || upstream.status === 304 || responseBuf.byteLength === 0) {
              res.status(upstream.status).end();
            } else {
              res.status(upstream.status).send(responseBuf);
            }
          }

          deps.log({
            severity: upstream.status >= 500 ? "WARN" : "INFO",
            message: "webhook_proxy",
            event: "webhook_proxy",
            provider,
            outcome: "forwarded",
            status: upstream.status,
            upstreamStatus: upstream.status,
            bodyBytes: rawBody.byteLength,
            latencyMs: Date.now() - started,
          });
        } catch (err) {
          const timeout = isTimeoutError(err);
          const status = timeout ? 504 : 502;
          const errorCode = timeout ? "upstream_timeout" : "proxy_error";
          const description = timeout ? "Webhook target timed out" : "Failed to reach webhook target";
          const errno = (err as { code?: unknown } | null)?.code;

          deps.log({
            severity: "ERROR",
            message: "webhook_proxy",
            event: "webhook_proxy",
            provider,
            outcome: timeout ? "upstream_timeout" : "upstream_error",
            reason: typeof errno === "string" ? errno : (err instanceof Error ? err.name : "unknown"),
            status,
            bodyBytes: rawBody.byteLength,
            latencyMs: Date.now() - started,
          });
          if (!res.headersSent) {
            res.status(status).json({
              error: errorCode,
              error_description: description,
            });
          }
        }
      })();
    });
  };
}

/**
 * Mount the generic raw-body `POST /webhooks/:provider` route (and 404/405 guard
 * for non-POST methods). Must be called BEFORE `app.use(express.json())`.
 */
export function mountWebhookRoutes(
  app: Express,
  deps: WebhookProxyDeps = defaultWebhookProxyDeps(),
): void {
  app.post("/webhooks/:provider", webhookProxyHandler(deps));
  app.all("/webhooks/:provider", (req, res) => {
    const provider = normalizeProviderSlug(req.params.provider);
    const allowed = activeAllowedProviders(deps, deps.env());
    if (!provider || !allowed.has(provider)) {
      res.status(404).json({
        error: "unknown_provider",
        error_description: "Webhook provider is not enabled",
      });
      return;
    }
    res.setHeader("Allow", "POST");
    res.status(405).json({
      error: "method_not_allowed",
      error_description: "Method not allowed - use POST for webhook delivery",
    });
  });
}
