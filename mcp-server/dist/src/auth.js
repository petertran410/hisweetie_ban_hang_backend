import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
const secret = new TextEncoder().encode(config.MCP_JWT_SECRET);
function findClient(clientId, clientSecret) {
    return config.MCP_CLIENTS.find((client) => client.clientId === clientId && client.clientSecret === clientSecret);
}
export async function issueAccessToken(client) {
    return new SignJWT({ name: client.name, scope: client.scopes.join(' ') })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(config.MCP_PUBLIC_URL)
        .setAudience(`${config.MCP_PUBLIC_URL}/mcp`)
        .setSubject(client.clientId)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret);
}
export async function tokenEndpoint(req, res) {
    const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':', 2)
        : [];
    const clientId = String(req.body?.client_id ?? basic[0] ?? '');
    const clientSecret = String(req.body?.client_secret ?? basic[1] ?? '');
    const client = findClient(clientId, clientSecret);
    if (req.body?.grant_type !== 'client_credentials' || !client) {
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials or grant type' });
        return;
    }
    const requested = String(req.body?.scope ?? '').split(' ').filter(Boolean);
    if (requested.some((scope) => !client.scopes.includes(scope))) {
        res.status(400).json({ error: 'invalid_scope' });
        return;
    }
    const scopes = requested.length ? requested : client.scopes;
    const token = await issueAccessToken({ ...client, scopes });
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') });
}
export async function requireBearer(req, res, next) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${config.MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`);
        res.status(401).json({ error: 'invalid_token' });
        return;
    }
    try {
        const { payload } = await jwtVerify(token, secret, {
            issuer: config.MCP_PUBLIC_URL,
            audience: `${config.MCP_PUBLIC_URL}/mcp`,
        });
        req.mcpAuth = {
            clientId: String(payload.sub),
            clientName: String(payload.name),
            scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
        };
        next();
    }
    catch {
        res.status(401).json({ error: 'invalid_token' });
    }
}
export function requireScope(req, scope) {
    if (!req.mcpAuth?.scopes.includes(scope))
        throw new Error(`Missing OAuth scope: ${scope}`);
}
//# sourceMappingURL=auth.js.map