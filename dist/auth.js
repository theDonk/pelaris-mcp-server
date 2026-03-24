export function verifyBearerToken(req, res, next) {
    const expectedToken = process.env.MCP_BEARER_TOKEN;
    if (!expectedToken) {
        res.status(500).json({ error: "Server misconfigured: MCP_BEARER_TOKEN not set" });
        return;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
    }
    const token = authHeader.slice(7);
    if (token !== expectedToken) {
        res.status(403).json({ error: "Invalid bearer token" });
        return;
    }
    next();
}
//# sourceMappingURL=auth.js.map