import { redis } from '../redis.js';
export async function listSubscriptions(req, res) {
    const entries = await redis.hvals(`mcp:webhooks:${req.mcpAuth.clientId}`);
    res.json({ data: entries.map((value) => JSON.parse(value)) });
}
export async function createSubscription(req, res) {
    if (!req.mcpAuth.scopes.includes('webhooks:manage'))
        return void res.status(403).json({ error: 'insufficient_scope' });
    const id = crypto.randomUUID();
    const subscription = {
        id,
        clientId: req.mcpAuth.clientId,
        event: String(req.body.event),
        targetUrl: String(req.body.targetUrl),
        secret: String(req.body.secret),
    };
    if (!/^https:\/\//.test(subscription.targetUrl) && process.env.NODE_ENV === 'production') {
        return void res.status(400).json({ error: 'target_url_must_use_https' });
    }
    await redis.hset(`mcp:webhooks:${subscription.clientId}`, id, JSON.stringify(subscription));
    res.status(201).json({ ...subscription, secret: undefined });
}
export async function deleteSubscription(req, res) {
    if (!req.mcpAuth.scopes.includes('webhooks:manage'))
        return void res.status(403).json({ error: 'insufficient_scope' });
    await redis.hdel(`mcp:webhooks:${req.mcpAuth.clientId}`, String(req.params.id));
    res.status(204).end();
}
//# sourceMappingURL=routes.js.map