/**
 * The client's network address at the gateway (Pelaris 1.4 B2a lane C, C6 a
 * and b; FL-3 OH-2, OH-3; panel P4-2, P4-13, P2-11). Mirrors wayfinder
 * `functions/src/security/client_ip.ts`.
 *
 * - `gatewayClientIp`: the X-Forwarded-For hop the shared `client_ip_hop`
 *   dial names (`first`, today's key, by default; `right_most` once an admin sets
 *   it after the hop read), only when it passes `net.isIP`, else `req.ip` when
 *   it does, else null. Used as the DCR limit key.
 * - `forwardedIpHeaders`: what the `/token` and `/revoke` proxies add for the
 *   function (OH-3): `x-pelaris-client-ip` (an `net.isIP` value only) with
 *   `x-pelaris-gateway-secret` = MCP_OAUTH_IP_HEADER_SECRET. Both are omitted
 *   when the secret is unset or under 32 bytes, or there is no valid address.
 *   The proxies build their outbound headers from scratch, so an inbound copy
 *   of either header is never forwarded.
 * - `logHopShapeOnce`: hop count and per-position address family (0, 4, 6),
 *   never an address; once per distinct shape per surface per instance, at
 *   most 20 (the hop read behind the CDN, PLAN_B2a §8 precondition 2).
 */
import net from "net";
import type { Request } from "express";

import type { ClientIpHop } from "./dials.js";

export const CLIENT_IP_HEADER = "x-pelaris-client-ip";
export const GATEWAY_SECRET_HEADER = "x-pelaris-gateway-secret";
export const MIN_HEADER_SECRET_BYTES = 32;

type HeaderBag = Request["headers"];

function headerValue(headers: HeaderBag, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

export function isIpAddress(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && net.isIP(value) !== 0;
}

function hops(headers: HeaderBag): string[] {
  const xff = headerValue(headers, "x-forwarded-for");
  return xff === "" ? [] : xff.split(",").map((h) => h.trim());
}

export function gatewayClientIp(req: { headers: HeaderBag; ip?: string }, hop: ClientIpHop): string | null {
  const list = hops(req.headers);
  if (list.length > 0) {
    const pick = hop === "right_most" ? list[list.length - 1] : list[0];
    if (isIpAddress(pick)) return pick;
  }
  return isIpAddress(req.ip) ? req.ip : null;
}

export function usableHeaderSecret(secret: string | undefined): string | null {
  const trimmed = (secret ?? "").trim();
  return Buffer.byteLength(trimmed, "utf8") >= MIN_HEADER_SECRET_BYTES ? trimmed : null;
}

export function forwardedIpHeaders(
  req: { headers: HeaderBag; ip?: string },
  opts: { secret: string | undefined; hop: ClientIpHop },
): Record<string, string> {
  const secret = usableHeaderSecret(opts.secret);
  if (secret == null) return {};
  const ip = gatewayClientIp(req, opts.hop);
  if (ip == null) return {};
  return { [CLIENT_IP_HEADER]: ip, [GATEWAY_SECRET_HEADER]: secret };
}

export interface HopShape {
  hops: number;
  families: number[];
  req_ip_matches: "first" | "right_most" | "both" | "none";
  req_ip_family: number;
  inbound_gateway_headers: boolean;
}

export function describeHopShape(req: { headers: HeaderBag; ip?: string }): HopShape {
  const list = hops(req.headers);
  const first = list[0];
  const last = list[list.length - 1];
  let matches: HopShape["req_ip_matches"] = "none";
  if (req.ip && list.length > 0) {
    if (req.ip === first && req.ip === last) matches = "both";
    else if (req.ip === first) matches = "first";
    else if (req.ip === last) matches = "right_most";
  }
  return {
    hops: list.length,
    families: list.slice(0, 8).map((h) => net.isIP(h)),
    req_ip_matches: matches,
    req_ip_family: typeof req.ip === "string" ? net.isIP(req.ip) : 0,
    inbound_gateway_headers: headerValue(req.headers, CLIENT_IP_HEADER) !== "" || headerValue(req.headers, GATEWAY_SECRET_HEADER) !== "",
  };
}

// At most 10 shapes per surface and 50 in all, so unauthenticated /register
// calls cannot starve the /token surface's hop read.
const MAX_SHAPES_PER_SURFACE = 10;
const MAX_SHAPES_LOGGED = 50;
const loggedShapes = new Set<string>();
const shapesPerSurface = new Map<string, number>();

export function logHopShapeOnce(req: { headers: HeaderBag; ip?: string }, surface: string, hop: ClientIpHop): void {
  if (loggedShapes.size >= MAX_SHAPES_LOGGED) return;
  const perSurface = shapesPerSurface.get(surface) ?? 0;
  if (perSurface >= MAX_SHAPES_PER_SURFACE) return;
  const shape = describeHopShape(req);
  const key = `${surface}|${JSON.stringify(shape)}`;
  if (loggedShapes.has(key)) return;
  loggedShapes.add(key);
  shapesPerSurface.set(surface, perSurface + 1);
  process.stdout.write(JSON.stringify({ severity: "INFO", event: "client_ip_hop_shape", surface, hop_dial: hop, ...shape }) + "\n");
}

export function __resetHopShapeLogForTest(): void {
  loggedShapes.clear();
  shapesPerSurface.clear();
}
