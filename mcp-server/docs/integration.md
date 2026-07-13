# CRM integration

## OAuth

```bash
curl -X POST https://sandbox-api.hisweetievietnam.com/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials'
```

Access tokens last one hour. Credentials for sandbox and production are separate.

## MCP

Use `@hisweetie/mcp-client` rather than raw JSON-RPC. The MCP endpoint is `POST /mcp`; it supports initialize, ping, `tools/list` and `tools/call` over stateless Streamable HTTP.

List operations use the pagination format already implemented by each POS API:

- Customers: `currentItem` is a zero-based offset and `pageSize` is the batch size.
- Orders/products/invoices: `page` and `limit` where supported by their existing DTO.
- Maximum batch size is 500; maximum customer offset accepted by the MCP schema is 50,000.

Write operations require an `idempotencyKey` UUID. Retrying the same tool with the same key returns the cached successful response instead of creating a duplicate.

## Webhook signatures

Future deliveries use:

```text
X-Hisweetie-Timestamp: <unix-seconds>
X-Hisweetie-Signature: HMAC_SHA256(secret, timestamp + "." + rawBody)
```

The client SDK exports `verifyHisweetieWebhook` and rejects timestamps older than five minutes by default.
