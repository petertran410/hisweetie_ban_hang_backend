-- Manual only. Do not execute automatically.
-- Additive migration: existing internal-use details remain normal stock.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "internal_use_details"
  ADD COLUMN IF NOT EXISTS "conditionType" TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE "internal_use_details"
  ADD COLUMN IF NOT EXISTS "soldExpiryDate" TIMESTAMP(3);

UPDATE "internal_use_details"
SET "conditionType" = 'normal'
WHERE "conditionType" IS NULL
   OR "conditionType" NOT IN ('normal', 'damaged', 'near_expiry');

ALTER TABLE "internal_use_details"
  ALTER COLUMN "conditionType" SET DEFAULT 'normal',
  ALTER COLUMN "conditionType" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'internal_use_details_condition_type_check'
      AND conrelid = 'internal_use_details'::regclass
  ) THEN
    ALTER TABLE "internal_use_details"
      ADD CONSTRAINT "internal_use_details_condition_type_check"
      CHECK ("conditionType" IN ('normal', 'damaged', 'near_expiry'))
      NOT VALID;
  END IF;
END $$;

COMMIT;

ALTER TABLE "internal_use_details"
  VALIDATE CONSTRAINT "internal_use_details_condition_type_check";
