-- Manual only. Do not execute automatically.
-- Bổ sung bảng liên kết nhiều-nhiều giữa phiếu chất lượng và hóa đơn bán hàng liên quan.
-- Chạy sau khi đã có bảng product_quality_tickets và invoices.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "product_quality_ticket_invoices" (
    "id" SERIAL PRIMARY KEY,
    "ticket_id" INTEGER NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pq_ticket_invoices_ticket" FOREIGN KEY ("ticket_id")
        REFERENCES "product_quality_tickets"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_pq_ticket_invoices_invoice" FOREIGN KEY ("invoice_id")
        REFERENCES "invoices"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_ticket_invoices_ticket_id_invoice_id_key"
    ON "product_quality_ticket_invoices"("ticket_id", "invoice_id");

CREATE INDEX IF NOT EXISTS "product_quality_ticket_invoices_invoice_id_idx"
    ON "product_quality_ticket_invoices"("invoice_id");

-- Backfill: đưa invoiceId hiện có của các phiếu cũ vào bảng liên kết.
INSERT INTO "product_quality_ticket_invoices" ("ticket_id", "invoice_id")
SELECT t."id", t."invoice_id"
FROM "product_quality_tickets" t
WHERE t."invoice_id" IS NOT NULL
ON CONFLICT ("ticket_id", "invoice_id") DO NOTHING;

COMMIT;
