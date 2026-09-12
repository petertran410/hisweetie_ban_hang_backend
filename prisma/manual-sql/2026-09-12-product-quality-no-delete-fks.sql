-- Manual only. Do not execute automatically.
-- Mục đích: bỏ ON DELETE CASCADE ở các bảng con của module Chất lượng hàng hóa,
-- chuyển sang ON DELETE RESTRICT để không mất dữ liệu khi phiếu/hóa đơn bị xóa.
-- Chạy sau khi đã có các bảng product_quality_tasks / product_quality_attachments
-- (và product_quality_ticket_invoices nếu đã tạo).
--
-- An toàn khi chạy lại: file tự tìm và xóa mọi FK cũ trên các cột liên quan,
-- sau đó tạo lại FK với RESTRICT.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Bỏ toàn bộ FK cũ (bất kể tên) trên các bảng con của module chất lượng.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT rel.relname AS table_name, con.conname AS constraint_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE con.contype = 'f'
          AND ns.nspname = 'public'
          AND rel.relname IN (
              'product_quality_tasks',
              'product_quality_attachments',
              'product_quality_ticket_invoices'
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT %I',
            r.table_name,
            r.constraint_name
        );
    END LOOP;
END $$;

-- 2. Tạo lại FK với RESTRICT.
ALTER TABLE "product_quality_tasks"
    ADD CONSTRAINT "fk_pq_tasks_ticket"
    FOREIGN KEY ("ticket_id") REFERENCES "product_quality_tickets"("id")
    ON DELETE RESTRICT;

ALTER TABLE "product_quality_attachments"
    ADD CONSTRAINT "fk_pq_attachments_ticket"
    FOREIGN KEY ("ticket_id") REFERENCES "product_quality_tickets"("id")
    ON DELETE RESTRICT;

-- 3. Bảng liên kết hóa đơn chỉ tồn tại nếu đã chạy file tạo bảng trước đó.
DO $$
BEGIN
    IF to_regclass('public.product_quality_ticket_invoices') IS NULL THEN
        RAISE NOTICE 'Bỏ qua: bảng product_quality_ticket_invoices chưa tồn tại.';
        RETURN;
    END IF;

    ALTER TABLE "product_quality_ticket_invoices"
        ADD CONSTRAINT "fk_pq_ticket_invoices_ticket"
        FOREIGN KEY ("ticket_id") REFERENCES "product_quality_tickets"("id")
        ON DELETE RESTRICT;

    ALTER TABLE "product_quality_ticket_invoices"
        ADD CONSTRAINT "fk_pq_ticket_invoices_invoice"
        FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
        ON DELETE RESTRICT;
END $$;

COMMIT;
