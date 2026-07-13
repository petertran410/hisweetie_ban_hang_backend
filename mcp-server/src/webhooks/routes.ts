import type { Request, Response } from 'express';
import { redis } from '../redis.js';

interface Subscription { id: string; clientId: string; event: string; targetUrl: string; secret: string }

export async function listSubscriptions(req: Request, res: Response): Promise<void> {
  const entries = await redis.hvals(`mcp:webhooks:${req.mcpAuth!.clientId}`);
  res.json({ data: entries.map((value: string) => JSON.parse(value) as Subscription) });
}

export async function createSubscription(req: Request, res: Response): Promise<void> {
  if (!req.mcpAuth!.scopes.includes('webhooks:manage')) return void res.status(403).json({ error: 'insufficient_scope' });
  const id = crypto.randomUUID();
  const subscription: Subscription = {
    id,
    clientId: req.mcpAuth!.clientId,
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

export async function deleteSubscription(req: Request, res: Response): Promise<void> {
  if (!req.mcpAuth!.scopes.includes('webhooks:manage')) return void res.status(403).json({ error: 'insufficient_scope' });
  await redis.hdel(`mcp:webhooks:${req.mcpAuth!.clientId}`, String(req.params.id));
  res.status(204).end();
}
