-- Manual only. Do not execute automatically.
-- Existing note values do not need to be preserved.
ALTER TABLE "customer_debt_notes"
  DROP COLUMN IF EXISTS "accountant_note",
  DROP COLUMN IF EXISTS "accountant_note_by",
  DROP COLUMN IF EXISTS "accountant_note_at",
  DROP COLUMN IF EXISTS "sale_note",
  DROP COLUMN IF EXISTS "sale_note_by",
  DROP COLUMN IF EXISTS "sale_note_at";

ALTER TABLE "customer_debt_notes"
  ADD COLUMN IF NOT EXISTS "note" TEXT,
  ADD COLUMN IF NOT EXISTS "note_by" INTEGER,
  ADD COLUMN IF NOT EXISTS "note_at" TIMESTAMP(3);
