-- Manual only. Do not execute automatically.
-- Migration: Tạo các bảng cho module Quản lý Chất Lượng Sản Phẩm (product_quality)
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Bảng phiếu sự cố chất lượng sản phẩm
CREATE TABLE IF NOT EXISTS "product_quality_tickets" (
    "id" SERIAL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "legacy_code" TEXT,
    "source_record_id" TEXT,
    "branch_id" INTEGER,
    "branch_name" TEXT,
    "customer_id" INTEGER,
    "customer_code" TEXT,
    "customer_name" TEXT NOT NULL,
    "product_id" INTEGER,
    "product_code" TEXT,
    "product_name" TEXT NOT NULL,
    "unit" TEXT,
    "source_type" TEXT,
    "quantity" DECIMAL(18, 4) NOT NULL DEFAULT 0,
    "expiry_date" TIMESTAMP(3),
    "reason" TEXT,
    "initial_classification" TEXT NOT NULL,
    "feedback_type" TEXT NOT NULL,
    "severity" TEXT,
    "responsibilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "factory_name" TEXT,
    "factory_id" INTEGER,
    "note" TEXT,
    "invoice_id" INTEGER,
    "invoice_code" TEXT,
    "outbound_invoice_id" INTEGER,
    "outbound_invoice_code" TEXT,
    "decision_maker_id" INTEGER,
    "decision_maker_name" TEXT,
    "handling_direction" TEXT,
    "assigned_departments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "handled_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,
    "closed_by_id" INTEGER,
    "created_by_id" INTEGER,
    "created_by_name" TEXT,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pqt_branch" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_customer" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_factory" FOREIGN KEY ("factory_id") REFERENCES "factories"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_outbound_invoice" FOREIGN KEY ("outbound_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_decision_maker" FOREIGN KEY ("decision_maker_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_creator" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pqt_closer" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_tickets_code_key" ON "product_quality_tickets"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_tickets_source_record_id_key" ON "product_quality_tickets"("source_record_id");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_branch_id_idx" ON "product_quality_tickets"("branch_id");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_status_idx" ON "product_quality_tickets"("status");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_created_at_idx" ON "product_quality_tickets"("created_at");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_due_at_idx" ON "product_quality_tickets"("due_at");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_customer_id_idx" ON "product_quality_tickets"("customer_id");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_product_id_idx" ON "product_quality_tickets"("product_id");
CREATE INDEX IF NOT EXISTS "product_quality_tickets_decision_maker_id_idx" ON "product_quality_tickets"("decision_maker_id");

-- 2. Bảng nhiệm vụ bộ phận xử lý
CREATE TABLE IF NOT EXISTS "product_quality_tasks" (
    "id" SERIAL PRIMARY KEY,
    "ticket_id" INTEGER NOT NULL,
    "department" TEXT NOT NULL,
    "assigned_user_id" INTEGER,
    "assigned_user_name" TEXT,
    "feedback" TEXT,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_by_id" INTEGER,
    "completed_by_name" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pq_tasks_ticket" FOREIGN KEY ("ticket_id") REFERENCES "product_quality_tickets"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_pq_tasks_assigned_user" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "fk_pq_tasks_completed_by" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_tasks_ticket_id_department_key" ON "product_quality_tasks"("ticket_id", "department");
CREATE INDEX IF NOT EXISTS "product_quality_tasks_department_is_completed_idx" ON "product_quality_tasks"("department", "is_completed");

-- 3. Bảng file đính kèm / minh chứng
CREATE TABLE IF NOT EXISTS "product_quality_attachments" (
    "id" SERIAL PRIMARY KEY,
    "ticket_id" INTEGER NOT NULL,
    "department" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PROOF_IMAGE',
    "filename" TEXT NOT NULL,
    "original_name" TEXT,
    "url" TEXT NOT NULL,
    "mimetype" TEXT,
    "size" INTEGER,
    "lark_file_token" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pq_attachments_ticket" FOREIGN KEY ("ticket_id") REFERENCES "product_quality_tickets"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_pq_attachments_creator" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "product_quality_attachments_ticket_id_idx" ON "product_quality_attachments"("ticket_id");

-- 4. Bảng cấu hình routing người quyết định
CREATE TABLE IF NOT EXISTS "product_quality_routing_configs" (
    "id" SERIAL PRIMARY KEY,
    "initial_classification" TEXT NOT NULL,
    "branch_id" INTEGER,
    "decision_maker_id" INTEGER NOT NULL,
    "fallback_to_creator" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pq_routing_decision_maker" FOREIGN KEY ("decision_maker_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "fk_pq_routing_branch" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_routing_configs_classification_branch_key" ON "product_quality_routing_configs"("initial_classification", "branch_id");

-- 5. Bảng thành viên các bộ phận theo chi nhánh
CREATE TABLE IF NOT EXISTS "product_quality_department_members" (
    "id" SERIAL PRIMARY KEY,
    "department" TEXT NOT NULL,
    "branch_id" INTEGER,
    "user_id" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_pq_dept_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_pq_dept_members_branch" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_quality_department_members_dept_branch_user_key" ON "product_quality_department_members"("department", "branch_id", "user_id");
CREATE INDEX IF NOT EXISTS "product_quality_department_members_dept_branch_idx" ON "product_quality_department_members"("department", "branch_id");

COMMIT;
