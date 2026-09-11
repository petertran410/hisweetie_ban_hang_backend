CREATE TABLE "invoice_merges" (
    "id" SERIAL NOT NULL,
    "targetInvoiceId" INTEGER NOT NULL,
    "representativeInvoiceId" INTEGER NOT NULL,
    "createdBy" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_merges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_merge_sources" (
    "id" SERIAL NOT NULL,
    "mergeId" INTEGER NOT NULL,
    "sourceInvoiceId" INTEGER NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "sourceOrderId" INTEGER,
    "sourceOrderCode" TEXT,
    "sourceDescription" TEXT,
    "sourcePurchaseDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_merge_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_merges_targetInvoiceId_idx" ON "invoice_merges"("targetInvoiceId");
CREATE INDEX "invoice_merges_representativeInvoiceId_idx" ON "invoice_merges"("representativeInvoiceId");
CREATE UNIQUE INDEX "invoice_merge_sources_mergeId_sourceInvoiceId_key" ON "invoice_merge_sources"("mergeId", "sourceInvoiceId");
CREATE INDEX "invoice_merge_sources_sourceInvoiceId_idx" ON "invoice_merge_sources"("sourceInvoiceId");
CREATE INDEX "invoice_merge_sources_sourceOrderId_idx" ON "invoice_merge_sources"("sourceOrderId");

ALTER TABLE "invoice_merges"
  ADD CONSTRAINT "invoice_merges_targetInvoiceId_fkey"
  FOREIGN KEY ("targetInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_merge_sources"
  ADD CONSTRAINT "invoice_merge_sources_mergeId_fkey"
  FOREIGN KEY ("mergeId") REFERENCES "invoice_merges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_merge_sources"
  ADD CONSTRAINT "invoice_merge_sources_sourceInvoiceId_fkey"
  FOREIGN KEY ("sourceInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
