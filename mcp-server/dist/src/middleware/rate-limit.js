import { redis } from '../redis.js';
export async function rateLimit(req, res, next) {
    const clientId = req.mcpAuth?.clientId;
    if (!clientId)
        return next();
    const minute = Math.floor(Date.now() / 60_000);
    const key = `mcp:rate:${clientId}:${minute}`;
    const count = await redis.incr(key);
    if (count === 1)
        await redis.expire(key, 70);
    res.setHeader('X-RateLimit-Limit', '200');
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, 200 - count)));
    if (count > 200) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: 'rate_limit_exceeded' });
        return;
    }
    next();
}
//# sourceMappingURL=rate-limit.js.map