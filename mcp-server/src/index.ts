import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config, allowedOrigins } from './config.js';
import { requireBearer, tokenEndpoint } from './auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { redis } from './redis.js';
import { createMcpServer } from './server.js';
import { createSubscription, deleteSubscription, listSubscriptions } from './webhooks/routes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return void res.status(403).json({ error: 'origin_not_allowed' });
  next();
});

app.get('/health', async (_req, res) => {
  const redisStatus = await redis.ping().catch(() => 'DOWN');
  res.status(redisStatus === 'PONG' ? 200 : 503).json({ status: redisStatus === 'PONG' ? 'ok' : 'degraded', redis: redisStatus });
});
app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({
  resource: `${config.MCP_PUBLIC_URL}/mcp`, authorization_servers: [config.MCP_PUBLIC_URL],
  scopes_supported: ['pos:read', 'pos:write', 'webhooks:manage'], bearer_methods_supported: ['header'],
}));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
  issuer: config.MCP_PUBLIC_URL, token_endpoint: `${config.MCP_PUBLIC_URL}/oauth/token`,
  grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
}));
app.post('/oauth/token', tokenEndpoint);

app.use('/mcp', requireBearer, rateLimit);
app.post('/mcp', async (req, res) => {
  // SDK Client.connect() sends initialize + notifications/initialized before tools/*.
  // Only block clearly unsupported methods; let the MCP transport handle the rest.
  const method = typeof req.body?.method === 'string' ? req.body.method : '';
  const allowed =
    isInitializeRequest(req.body) ||
    method === 'tools/list' ||
    method === 'tools/call' ||
    method === 'ping' ||
    method.startsWith('notifications/');
  if (!allowed) {
    return void res.status(400).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32601, message: `Method not supported: ${method || 'unknown'}` },
    });
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get('/mcp', (_req, res) => res.status(405).setHeader('Allow', 'POST').end());
app.delete('/mcp', (_req, res) => res.status(405).setHeader('Allow', 'POST').end());

app.get('/webhooks', requireBearer, rateLimit, listSubscriptions);
app.post('/webhooks', requireBearer, rateLimit, createSubscription);
app.delete('/webhooks/:id', requireBearer, rateLimit, deleteSubscription);

async function main(): Promise<void> {
  await redis.connect();
  app.listen(config.MCP_PORT, '0.0.0.0', () => console.log(`Hisweetie MCP server listening on ${config.MCP_PORT}`));
}

main().catch((error) => { console.error(error); process.exit(1); });
