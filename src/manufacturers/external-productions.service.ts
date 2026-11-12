import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ManufacturersService } from './manufacturers.service';
import { CreateProductionDto } from '../productions/dto/create-production.dto';
import { ReceiveProductionDto } from '../productions/dto/production-factory.dto';
import { ManufacturerMaterialDto, OwnMaterialDto } from './dto';
import { externalCosts, materialAmount, money, ownConversion, slipQuantity } from './external-production.util';
import { normalizeNsxUnit } from '../common/nsx-pricing.util';
import { buildInventoryLogBase } from '../common/inventory-log.util';
import { computeWeightedAverageCost, ensureInventoryRow } from '../common/production-factory.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import { outputSpec } from '../productions/production-cost.util';

export const EXTERNAL_INCLUDE = {
  components: true, manufacturerMaterials: true,
  manufacturer: { select: { id: true, code: true, name: true, supplierId: true } },
  supplier: { select: { id: true, code: true, name: true } },
} as const;

@Injectable()
export class ExternalProductionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manufacturers: ManufacturersService,
    private readonly audit: AuditLogsService,
  ) {}

  private async locked(tx: Prisma.TransactionClient, id: number) {
    await tx.$queryRaw`SELECT id FROM productions WHERE id = ${id} FOR UPDATE`;
    const row = await tx.production.findUnique({ where: { id }, include: EXTERNAL_INCLUDE });
    if (!row?.manufacturerId) throw new NotFoundException('Không tìm thấy phiếu gửi sản xuất mới');
    return row;
  }

  private async materials(
    tx: Prisma.TransactionClient, own: OwnMaterialDto[], supplied: ManufacturerMaterialDto[], strict = false,
  ) {
    const products = await this.manufacturers.validateMaterials(tx, own, supplied, strict);
    return {
      own: own.map((line) => {
        const product = products.get(line.productId);
        const conversionFactor = ownConversion(product, line.unit);
        return {
          componentProductId: line.productId, componentCode: product.code, componentName: product.name,
          formulaGrams: line.quantity, actualGrams: line.quantity, unitsDeducted: 0,
          unit: line.unit, inputMode: 'external', conversionFactor, unitCost: 0,
        };
      }),
      supplied: supplied.map((line) => {
        const priceUnit = line.pricingMode === 'UNIT_PRICE' ? line.priceUnit ?? null : null;
        const product = line.productId ? products.get(line.productId) : null;
        return {
          productId: line.productId ?? null,
          productCode: product?.code ?? null,
          description: (product ? product.name : line.description?.trim()) || 'Nguyên liệu NSX bổ sung',
          quantity: line.quantity == null ? null
            : line.pricingMode === 'UNIT_PRICE' ? slipQuantity(line.quantity) : line.quantity,
          unit: priceUnit ? normalizeNsxUnit(line.unit) : line.unit ?? null,
          pricingMode: line.pricingMode, unitPrice: line.unitPrice ?? 0, priceUnit,
          amount: materialAmount(line),
        };
      }),
    };
  }

  /** Dòng NSX đã lưu → DTO, giữ priceUnit để tính lại đúng (300 g × đ/kg). */
  static suppliedFromRows(rows: any[]): ManufacturerMaterialDto[] {
    return rows.map((line) => ({
      productId: line.productId, description: line.description,
      quantity: line.quantity == null ? null : Number(line.quantity),
      unit: line.unit, pricingMode: line.pricingMode as 'TOTAL' | 'UNIT_PRICE',
      unitPrice: Number(line.unitPrice), priceUnit: line.priceUnit ?? null, amount: Number(line.amount),
    }));
  }

  /**
   * Công thức gửi đi của phiếu. Giữ nguyên công thức đã lưu nếu cả công thức
   * lẫn thành phẩm không đổi (công thức có thể đã bị đổi tên/tắt sau đó).
   */
  private async resolveFormula(
    tx: Prisma.TransactionClient, requested: number | null | undefined, productId: number, existing?: any,
  ): Promise<{ formulaId: number | null; formulaName: string | null }> {
    const formulaId = requested ?? null;
    if (existing && formulaId === existing.formulaId && productId === existing.productId) {
      return { formulaId: existing.formulaId, formulaName: existing.formulaName };
    }
    if (!formulaId) return { formulaId: null, formulaName: null };
    const formula = await tx.productFormula.findUnique({
      where: { id: formulaId }, select: { id: true, name: true, productId: true, isExternal: true },
    });
    if (!formula || formula.productId !== productId || !formula.isExternal) {
      throw new BadRequestException('Công thức gửi sản xuất không thuộc thành phẩm đã chọn');
    }
    return { formulaId: formula.id, formulaName: formula.name };
  }

  async save(dto: CreateProductionDto, userId: number, id?: number) {
    await this.internal(userId);
    return this.prisma.$transaction(async (tx) => {
      const existing = id ? await this.locked(tx, id) : undefined;
      if (existing && existing.status !== 1) throw new BadRequestException('Chỉ sửa được phiếu tạm');
      const [manufacturer, product, source, dest, user] = await Promise.all([
        tx.manufacturer.findUnique({ where: { id: dto.manufacturerId! } }),
        tx.product.findUnique({ where: { id: dto.productId } }),
        tx.branch.findUnique({ where: { id: dto.sourceBranchId } }),
        tx.branch.findUnique({ where: { id: dto.destinationBranchId } }),
        tx.user.findUnique({ where: { id: userId } }),
      ]);
      if (!manufacturer?.isActive) throw new BadRequestException('Nhà sản xuất không hợp lệ');
      if (!product || ![2, 4].includes(product.type)) throw new BadRequestException('Thành phẩm phải là hàng hóa có quản lý tồn');
      if (!source || !dest || !user) throw new BadRequestException('Kho hoặc người thực hiện không hợp lệ');
      if (!(dto.quantity > 0)) throw new BadRequestException('Sản lượng phải lớn hơn 0');
      const own = dto.ownMaterials ?? [];
      const supplied = dto.manufacturerMaterials ?? [];
      const rows = await this.materials(tx, own, supplied, true);
      const formula = await this.resolveFormula(tx, dto.formulaId, product.id, existing);
      const currency = dto.feeCurrency ?? manufacturer.currency;
      const fee = currency === 'CNY' ? dto.feeForeignAmount ?? 0 : dto.processingFee ?? 0;
      const costs = externalCosts(supplied, fee, currency, dto.feeExchangeRate ?? 1);
      const data = {
        isExternal: true, manufacturerId: manufacturer.id, factoryId: null, supplierId: null,
        productId: product.id, productCode: product.code, productName: product.name,
        sourceBranchId: source.id, sourceBranchName: source.name,
        destinationBranchId: dest.id, destinationBranchName: dest.name,
        quantity: dto.quantity, note: dto.note, status: 1, autoDeductComponents: true,
        feeCurrency: currency, feeForeignAmount: currency === 'CNY' ? fee : null,
        feeExchangeRate: currency === 'CNY' ? dto.feeExchangeRate ?? 1 : null,
        ...formula,
        ...costs,
      };
      // Mẫu phối trộn đã bỏ: phiếu cũ giữ nguyên externalTemplate*, phiếu mới để trống.
      const saved = id
        ? await tx.production.update({ where: { id }, data: { ...data, components: { deleteMany: {}, create: rows.own }, manufacturerMaterials: { deleteMany: {}, create: rows.supplied } }, include: EXTERNAL_INCLUDE })
        : await tx.production.create({ data: {
            ...data, externalTemplateId: null, externalTemplateName: null, externalTemplateSnapshot: Prisma.DbNull,
            code: dto.code?.trim() || `GSX${randomUUID().slice(0, 8).toUpperCase()}`,
            createdById: user.id, createdByName: user.name ?? user.email,
            components: { create: rows.own }, manufacturerMaterials: { create: rows.supplied },
          }, include: EXTERNAL_INCLUDE });
      return saved;
    });
  }

  async send(id: number, sentDate: string | undefined, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await this.locked(tx, id);
      if (row.status !== 1) throw new ConflictException('Phiếu không còn ở trạng thái tạm');
      if (!row.components.length && !row.manufacturerMaterials.length) throw new BadRequestException('Vui lòng nhập nguyên liệu');
      await tx.$queryRaw`SELECT id FROM manufacturers WHERE id = ${row.manufacturerId!} FOR UPDATE`;
      const manufacturer = await tx.manufacturer.findUnique({ where: { id: row.manufacturerId! } });
      if (!manufacturer?.isActive) throw new BadRequestException('Nhà sản xuất đã ngừng hoạt động');
      const user = await tx.user.findUnique({ where: { id: userId } });
      const date = sentDate ? new Date(sentDate) : new Date();
      let value = new Prisma.Decimal(0);
      for (const component of [...row.components].sort((a, b) => a.componentProductId - b.componentProductId)) {
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${component.componentProductId} AND "branchId" = ${row.sourceBranchId} FOR UPDATE`;
        const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: component.componentProductId, branchId: row.sourceBranchId } } });
        const units = new Prisma.Decimal(component.actualGrams).mul(component.conversionFactor ?? 1).toDecimalPlaces(4);
        if (!units.gt(0)) throw new BadRequestException(`Lượng gửi quá nhỏ sau quy đổi: ${component.componentName}`);
        if (!inv || new Prisma.Decimal(inv.onHand).lt(units)) throw new BadRequestException(`Không đủ tồn kho: ${component.componentName}`);
        value = value.add(units.mul(inv.cost));
        await tx.productionComponent.update({ where: { id: component.id }, data: { unitsDeducted: units, unitCost: inv.cost } });
        await tx.inventoryLog.create({ data: {
          productId: component.componentProductId, productCode: component.componentCode, productName: component.componentName,
          branchId: row.sourceBranchId, branchName: row.sourceBranchName, transactionType: 'PRODUCTION_OUT',
          refType: 'production', refId: row.id, refCode: row.code, quantity: units.negated(), costPrice: inv.cost,
          transactionDate: date, ...buildInventoryLogBase({ userId, userName: user?.name ?? user?.email }),
        } });
      }
      await tx.production.update({ where: { id }, data: {
        status: 4, sentDate: date, supplierId: manufacturer.supplierId,
        materialValue: money(value), totalCost: money(value.add(row.totalPayable)),
      } });
      await recalcOnHandForPairs(tx, row.components.map((line) => ({ productId: line.componentProductId, branchId: row.sourceBranchId })));
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_SEND', result, userId);
    return result;
  }

  async receive(id: number, dto: ReceiveProductionDto, userId: number) {
    if (dto.newCost != null || dto.costScope != null || dto.expectedOldCost != null || dto.expectedCosts != null) {
      throw new BadRequestException('Nhận hàng không áp giá vốn. Hãy dùng thao tác Áp dụng giá vốn sau khi hoàn thành');
    }
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.locked(tx, id);
      if (row.status !== 4) throw new ConflictException('Chỉ nhận được phiếu đã gửi, chưa nhận');
      const quantity = new Prisma.Decimal(dto.receivedQuantity ?? row.quantity).toDecimalPlaces(4).toNumber();
      if (!(quantity > 0)) throw new BadRequestException('Số lượng nhận phải lớn hơn 0');
      const date = dto.completedDate ? new Date(dto.completedDate) : new Date();
      if (row.sentDate && date.toISOString().slice(0, 10) < row.sentDate.toISOString().slice(0, 10)) throw new BadRequestException('Ngày nhận không được trước ngày gửi');
      const supplied = dto.manufacturerMaterials ?? ExternalProductionsService.suppliedFromRows(row.manufacturerMaterials);
      const rows = await this.materials(tx, [], supplied);
      const rate = dto.feeExchangeRate ?? Number(row.feeExchangeRate ?? 1);
      const fee = row.feeCurrency === 'CNY' ? dto.feeForeignAmount ?? Number(row.feeForeignAmount ?? 0) : dto.processingFee ?? Number(row.processingFee);
      const costs = externalCosts(supplied, fee, row.feeCurrency, rate, Number(row.materialValue));
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${row.productId} FOR UPDATE`;
      const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId } });
      if (![2, 4].includes(product.type)) throw new BadRequestException('Thành phẩm không còn là hàng hóa quản lý tồn');
      const batchUnitCost = new Prisma.Decimal(costs.totalCost).div(quantity).toDecimalPlaces(6);
      await ensureInventoryRow(tx, row.productId, row.destinationBranchId);
      await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${row.productId} AND "branchId" = ${row.destinationBranchId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      await tx.inventoryLog.create({ data: {
        productId: row.productId, productCode: row.productCode, productName: row.productName,
        branchId: row.destinationBranchId, branchName: row.destinationBranchName,
        transactionType: 'PRODUCTION_IN', refType: 'production', refId: row.id, refCode: row.code,
        quantity, costPrice: batchUnitCost, transactionDate: date,
        ...buildInventoryLogBase({ userId, userName: user?.name ?? user?.email }),
      } });
      await tx.production.update({ where: { id }, data: {
        status: 2, receivedQuantity: quantity, completedDate: date, ...costs, debtAmount: costs.totalPayable,
        batchUnitCost, outputSpecSnapshot: { ...outputSpec(product) }, costSnapshotAt: new Date(),
        feeExchangeRate: row.feeCurrency === 'CNY' ? rate : null,
        feeForeignAmount: row.feeCurrency === 'CNY' ? fee : null,
        manufacturerMaterials: { deleteMany: {}, create: rows.supplied },
      } });
      await recalcOnHandForPairs(tx, [{ productId: row.productId, branchId: row.destinationBranchId }]);
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_RECEIVE', result, userId);
    return result;
  }

  async preview(id: number, quantity?: number, processingFee?: number) {
    const row = await this.prisma.production.findUnique({ where: { id }, include: EXTERNAL_INCLUDE });
    if (!row || ![2, 4].includes(row.status)) throw new BadRequestException('Chỉ xem giá thành phiếu đã gửi hoặc hoàn thành');
    const received = row.status === 2 ? Number(row.receivedQuantity) : quantity ?? Number(row.quantity);
    const fee = row.status === 4 && processingFee != null ? processingFee : Number(row.processingFee);
    const totalCost = Number(row.materialValue) + Number(row.manufacturerMaterialCost) + fee;
    const inventories = await this.prisma.inventory.findMany({ where: { productId: row.productId } });
    const inv = inventories.find((item) => item.branchId === row.destinationBranchId);
    const onHand = Number(inv?.onHand ?? 0), oldCost = Number(inv?.cost ?? 0);
    const unitCost = received > 0 ? totalCost / received : 0;
    return {
      productionId: id, productName: row.productName, receiveBranchId: row.destinationBranchId,
      receiveBranchName: row.destinationBranchName, materialValue: Number(row.materialValue),
      manufacturerMaterialCost: Number(row.manufacturerMaterialCost), processingFee: fee,
      totalCost, totalPayable: Number(row.manufacturerMaterialCost) + fee, receivedQuantity: received,
      unitCost, onHand, oldCost, branchCount: inventories.length,
      ...computeWeightedAverageCost({ otherQuantity: row.status === 2 ? onHand - received : onHand, oldCost, receivedQuantity: received, unitCost }),
      applied: !!row.costAppliedAt, appliedUnitCost: row.appliedUnitCost == null ? null : Number(row.appliedUnitCost),
    };
  }

  async cancel(id: number, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.locked(tx, id);
      if (row.status === 3) throw new BadRequestException('Phiếu đã hủy');
      if (await tx.payableAllocation.count({ where: { productionId: id, status: 1 } })) throw new BadRequestException('Hãy hủy phân bổ thanh toán trước khi hủy phiếu sản xuất');
      const pairs = [...row.components.map((line) => ({ productId: line.componentProductId, branchId: row.sourceBranchId })), { productId: row.productId, branchId: row.destinationBranchId }];
      for (const key of [...new Set(pairs.map((pair) => `${pair.productId}:${pair.branchId}`))].sort()) {
        const [productId, branchId] = key.split(':').map(Number);
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${productId} AND "branchId" = ${branchId} FOR UPDATE`;
      }
      await tx.production.update({ where: { id }, data: { status: 3, debtAmount: 0 } });
      await recalcOnHandForPairs(tx, pairs);
      for (const pair of pairs) {
        const inv = await tx.inventory.findUnique({ where: { productId_branchId: pair } });
        if (inv && Number(inv.onHand) < 0) throw new BadRequestException('Hàng đã được xuất tiếp, không thể hủy phiếu');
      }
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_CANCEL', result, userId);
    return result;
  }

  private async log(actionCode: string, row: any, userId: number) {
    await this.audit.create({
      actionType: 'POST', actionCode, entityType: 'productions', entityId: String(row.id),
      entityCode: row.code, message: `${actionCode}: ${row.code}`, userId, userName: row.createdByName,
      branchId: row.sourceBranchId, snapshot: JSON.parse(JSON.stringify(row)),
    });
  }

  private async lockAccount(tx: Prisma.TransactionClient, id: number) {
    const row = await tx.production.findUnique({ where: { id }, select: { supplierId: true, manufacturerId: true } });
    if (row?.supplierId) await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${row.supplierId} FOR UPDATE`;
    else if (row?.manufacturerId) await tx.$queryRaw`SELECT id FROM manufacturers WHERE id = ${row.manufacturerId} FOR UPDATE`;
  }

  private async internal(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { supplierId: true } });
    if (user?.supplierId) throw new ForbiddenException('Luồng gửi sản xuất chỉ dành cho nhân viên nội bộ');
  }
}
