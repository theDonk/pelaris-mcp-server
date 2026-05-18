// CORS middleware for the Pelaris MCP server.
//
// The MCP server is normally reached server-to-server (Claude, ChatGPT,
// Gemini, MCP CLIs) where CORS does not apply. The Pelaris-owned browser
// surfaces below need it because the browser will preflight any cross-origin
// fetch to /register, /token, /mcp and friends.
//
// Allowed origins are an explicit allow-list. Anything not in the list
// (including the `null` origin of file:// pages) gets no
// Access-Control-Allow-Origin header back, so the browser blocks the
// response. This keeps random local HTML files off the API while letting
// Pelaris-owned local dashboards (the "island" wrapper) and the production
// Pelaris surfaces talk to it.
//
// Extending the list at runtime: set ALLOWED_ORIGINS as a comma-separated
// string on the Cloud Run service. Entries are unioned with the defaults
// below.

import type { Request, Response, NextFunction } from "express";

const DEFAULT_ALLOWED_ORIGINS = [
  // Local Pelaris dashboards served via the "island" PowerShell HTTP server.
  // Ports 8765-8767 cover the standard island launch + variants.
  "http://localhost:8765",
  "http://localhost:8766",
  "http://localhost:8767",
  "http://127.0.0.1:8765",
  "http://127.0.0.1:8766",
  "http://127.0.0.1:8767",

  // Production Pelaris surfaces.
  "https://pelaris.io",
  "https://app.pelaris.io",
  "https://admin.pelaris.io",
];

const ALLOWED = (() => {
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...fromEnv]);
})();

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (typeof origin === "string" && ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  // These respond on every request, including non-allowed origins. They do
  // no harm because the browser only honours them when Allow-Origin is set.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}
