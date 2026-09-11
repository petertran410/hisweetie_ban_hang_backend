-- Manual only. Do not execute automatically.
-- Additive migration for Public API & Webhooks:
-- - Token version for instantaneous revocation on secret rotate / client deactivate
-- - Keyset cursor (cursor_id), multi-instance locking (locked_at, locked_by) for webhooks
-- - Event ID and event type tracking for deliveries
-- - Event outbox table for high-reliability business domain events
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. PublicApiClient: token_version
ALTER TABLE "public_api_clients"
  ADD COLUMN IF NOT EXISTS "token_version" INT NOT NULL DEFAULT 1;

-- 2. PublicApiWebhook: cursor_id, locked_at, locked_by
ALTER TABLE "public_api_webhooks"
  ADD COLUMN IF NOT EXISTS "cursor_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "locked_by" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "public_api_webhooks_active_failure_locked_idx"
  ON "public_api_webhooks" ("is_active", "failure_count", "locked_at");

-- 3. PublicApiWebhookDelivery: event_id, event_type
ALTER TABLE "public_api_webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "event_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "event_type" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "public_api_webhook_deliveries_event_id_idx"
  ON "public_api_webhook_deliveries" ("event_id");

-- 4. PublicApiEventOutbox: durable domain event outbox
CREATE TABLE IF NOT EXISTS "public_api_event_outbox" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_id" VARCHAR(120) NOT NULL UNIQUE,
  "resource" VARCHAR(50) NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "aggregate_id" INT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "attempts" INT NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "locked_at" TIMESTAMP,
  "locked_by" VARCHAR(100),
  "last_error" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "public_api_event_outbox_status_next_attempt_idx"
  ON "public_api_event_outbox" ("status", "next_attempt_at");

CREATE INDEX IF NOT EXISTS "public_api_event_outbox_resource_aggregate_idx"
  ON "public_api_event_outbox" ("resource", "aggregate_id");

COMMIT;
