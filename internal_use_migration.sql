-- CreateTable
CREATE TABLE "internal_uses" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "branchName" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 1,
    "transDate" TIMESTAMP(3),
    "purposeId" INTEGER NOT NULL,
    "userId" INTEGER,
    "userName" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdByName" TEXT NOT NULL,
    "description" TEXT,
    "totalValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_use_details" (
    "id" SERIAL NOT NULL,
    "internalUseId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unit" TEXT,
    "quantity" DECIMAL(65,30) NOT NULL,
    "cost" DECIMAL(65,30) NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_use_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_use_purposes" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 999,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "internal_use_purposes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_uses_code_key" ON "internal_uses"("code");

-- CreateIndex
CREATE INDEX "internal_uses_branchId_idx" ON "internal_uses"("branchId");

-- CreateIndex
CREATE INDEX "internal_uses_status_idx" ON "internal_uses"("status");

-- CreateIndex
CREATE INDEX "internal_uses_transDate_idx" ON "internal_uses"("transDate");

-- AddForeignKey
ALTER TABLE "internal_uses" ADD CONSTRAINT "internal_uses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_uses" ADD CONSTRAINT "internal_uses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_uses" ADD CONSTRAINT "internal_uses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_uses" ADD CONSTRAINT "internal_uses_purposeId_fkey" FOREIGN KEY ("purposeId") REFERENCES "internal_use_purposes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_use_details" ADD CONSTRAINT "internal_use_details_internalUseId_fkey" FOREIGN KEY ("internalUseId") REFERENCES "internal_uses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_use_details" ADD CONSTRAINT "internal_use_details_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

