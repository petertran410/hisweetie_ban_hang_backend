-- Manual only. Do not execute automatically.
-- Additive migration: old records remain compatible with shippingFee = 0.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "shippingFee" DECIMAL(65, 30) NOT NULL DEFAULT 0;

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "shippingFee" DECIMAL(65, 30) NOT NULL DEFAULT 0;

ALTER TABLE "consignments"
  ADD COLUMN IF NOT EXISTS "shippingFee" DECIMAL(65, 30) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_shipping_fee_nonnegative'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_shipping_fee_nonnegative"
      CHECK ("shippingFee" >= 0 AND "shippingFee"::text NOT IN ('NaN', 'Infinity', '-Infinity'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_shipping_fee_nonnegative'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_shipping_fee_nonnegative"
      CHECK ("shippingFee" >= 0 AND "shippingFee"::text NOT IN ('NaN', 'Infinity', '-Infinity'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consignments_shipping_fee_nonnegative'
  ) THEN
    ALTER TABLE "consignments"
      ADD CONSTRAINT "consignments_shipping_fee_nonnegative"
      CHECK ("shippingFee" >= 0 AND "shippingFee"::text NOT IN ('NaN', 'Infinity', '-Infinity'))
      NOT VALID;
  END IF;
END $$;

COMMIT;

ALTER TABLE "orders"
  VALIDATE CONSTRAINT "orders_shipping_fee_nonnegative";
ALTER TABLE "invoices"
  VALIDATE CONSTRAINT "invoices_shipping_fee_nonnegative";
ALTER TABLE "consignments"
  VALIDATE CONSTRAINT "consignments_shipping_fee_nonnegative";
