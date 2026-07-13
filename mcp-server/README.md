# Hisweetie POS MCP Server

Remote MCP gateway for CRM and third-party applications. It does not access PostgreSQL directly; every POS operation calls the existing NestJS API so inventory, debt, cash-flow, audit and integration side effects stay in one business path.

## Endpoints

- `POST /oauth/token`: OAuth client credentials.
- `POST /mcp`: stateless MCP Streamable HTTP.
- `GET|POST /webhooks`, `DELETE /webhooks/:id`: subscription management.
- `GET /health`: Redis readiness.
- `GET /.well-known/oauth-protected-resource`: RFC 9728 metadata.

## Local setup

1. Copy `.env.example` to `.env` and set a dedicated POS service-account email/password.
2. Set a random `MCP_JWT_SECRET` different from the NestJS JWT secret.
3. Configure at least one OAuth client in `MCP_CLIENTS`.
4. Start Redis and run `yarn dev`.

The default limit is 200 authenticated requests per client per minute. Write tools require a UUID idempotency key and cache successful results for 24 hours.

## Tool catalog

The server exposes 25 CRM tools covering customers, customer debt, products, inventory, orders, invoices, payments, reports and branches. Call MCP `tools/list` to obtain their runtime JSON schemas.

## Security

- Production webhook target URLs must use HTTPS.
- OAuth client secrets and POS service credentials must never be committed.
- Production and sandbox use separate OAuth clients, JWT secrets, POS accounts and Redis databases.
- The POS service account determines which existing NestJS endpoints and branches can be used.

## Webhook delivery status

This release includes subscription storage and HMAC verification helpers. Publishing POS domain events still requires the NestJS backend to emit events after successful transactions. That hook is intentionally not added here because it touches existing order/invoice/payment business services and must be designed per event to avoid emitting before transaction commit.

See `docs/integration.md` and `openapi.yaml`.
