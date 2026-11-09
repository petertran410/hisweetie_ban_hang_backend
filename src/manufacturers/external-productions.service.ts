import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ManufacturersService } from './manufacturers.service';
import { CreateProductionDto } from '../productions/dto/create-production.dto';
import { ReceiveProductionDto } from '../productions/dto/production-factory.dto';
import { ManufacturerMaterialDto, OwnMaterialDto } from './dto';
import { externalCosts, materialAmount, money, ownConversion } from './external-production.util';
import { buildInventoryLogBase } from '../common/inventory-log.util';
import { computeWeightedAverageCost, ensureInventoryRow } from '../common/production-factory.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';

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

  private async materials(tx: Prisma.TransactionClient, own: OwnMaterialDto[], supplied: ManufacturerMaterialDto[]) {
    const products = await this.manufacturers.validateMaterials(tx, own, supplied);
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
      supplied: supplied.map((line) => ({
        productId: line.productId ?? null,
        productCode: line.productId ? products.get(line.productId).code : null,
        description: line.description?.trim() || (line.productId ? products.get(line.productId).name : 'Nguyên liệu NSX bổ sung'),
        quantity: line.quantity ?? null, unit: line.unit ?? null,
        pricingMode: line.pricingMode, unitPrice: line.unitPrice ?? 0, amount: materialAmount(line),
      })),
    };
  }

  async save(dto: CreateProductionDto, userId: number, id?: number) {
    await this.internal(userId);
    return this.prisma.$transaction(async (tx) => {
      if (id) {
        const existing = await this.locked(tx, id);
        if (existing.status !== 1) throw new BadRequestException('Chỉ sửa được phiếu tạm');
      }
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
      const rows = await this.materials(tx, own, supplied);
      let template: any = null;
      if (dto.externalTemplateId) {
        template = await tx.externalProductionTemplate.findUnique({ where: { id: dto.externalTemplateId }, include: { lines: true } });
        if (!template?.isActive || template.manufacturerId !== manufacturer.id || template.productId !== product.id) {
          throw new BadRequestException('Mẫu không thuộc nhà sản xuất và thành phẩm đã chọn');
        }
      }
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
        externalTemplateId: template?.id ?? null, externalTemplateName: template?.name ?? null,
        externalTemplateSnapshot: template ? JSON.parse(JSON.stringify(template)) : Prisma.DbNull,
        ...costs,
      };
      const saved = id
        ? await tx.production.update({ where: { id }, data: { ...data, components: { deleteMany: {}, create: rows.own }, manufacturerMaterials: { deleteMany: {}, create: rows.supplied } }, include: EXTERNAL_INCLUDE })
        : await tx.production.create({ data: {
            ...data, code: dto.code?.trim() || `GSX${randomUUID().slice(0, 8).toUpperCase()}`,
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
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.locked(tx, id);
      if (row.status !== 4) throw new ConflictException('Chỉ nhận được phiếu đã gửi, chưa nhận');
      const quantity = dto.receivedQuantity ?? Number(row.quantity);
      if (!(quantity > 0)) throw new BadRequestException('Số lượng nhận phải lớn hơn 0');
      const date = dto.completedDate ? new Date(dto.completedDate) : new Date();
      if (row.sentDate && date.toISOString().slice(0, 10) < row.sentDate.toISOString().slice(0, 10)) throw new BadRequestException('Ngày nhận không được trước ngày gửi');
      const supplied = dto.manufacturerMaterials ?? row.manufacturerMaterials.map((line) => ({
        productId: line.productId, description: line.description, quantity: line.quantity == null ? null : Number(line.quantity),
        unit: line.unit, pricingMode: line.pricingMode as 'TOTAL' | 'UNIT_PRICE', unitPrice: Number(line.unitPrice), amount: Number(line.amount),
      }));
      const rows = await this.materials(tx, [], supplied);
      const rate = dto.feeExchangeRate ?? Number(row.feeExchangeRate ?? 1);
      const fee = row.feeCurrency === 'CNY' ? dto.feeForeignAmount ?? Number(row.feeForeignAmount ?? 0) : dto.processingFee ?? Number(row.processingFee);
      const costs = externalCosts(supplied, fee, row.feeCurrency, rate, Number(row.materialValue));
      await ensureInventoryRow(tx, row.productId, row.destinationBranchId);
      await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${row.productId} AND "branchId" = ${row.destinationBranchId} FOR UPDATE`;
      if (dto.newCost != null && dto.expectedOldCost != null) {
        const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: row.productId, branchId: row.destinationBranchId } } });
        if (Math.abs(Number(inv?.cost ?? 0) - dto.expectedOldCost) > 0.005) throw new ConflictException('Giá vốn đã thay đổi; vui lòng mở lại bước nhận hàng');
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      await tx.inventoryLog.create({ data: {
        productId: row.productId, productCode: row.productCode, productName: row.productName,
        branchId: row.destinationBranchId, branchName: row.destinationBranchName,
        transactionType: 'PRODUCTION_IN', refType: 'production', refId: row.id, refCode: row.code,
        quantity, costPrice: costs.totalCost / quantity, transactionDate: date,
        ...buildInventoryLogBase({ userId, userName: user?.name ?? user?.email }),
      } });
      await tx.production.update({ where: { id }, data: {
        status: 2, receivedQuantity: quantity, completedDate: date, ...costs, debtAmount: costs.totalPayable,
        feeExchangeRate: row.feeCurrency === 'CNY' ? rate : null,
        feeForeignAmount: row.feeCurrency === 'CNY' ? fee : null,
        manufacturerMaterials: { deleteMany: {}, create: rows.supplied },
      } });
      await recalcOnHandForPairs(tx, [{ productId: row.productId, branchId: row.destinationBranchId }]);
      if (dto.newCost != null) await this.applyCostTx(tx, row, dto.newCost, dto.costScope);
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

  private async applyCostTx(tx: Prisma.TransactionClient, row: { id: number; productId: number; destinationBranchId: number }, cost: number, scope?: string) {
    if (!(cost > 0)) throw new BadRequestException('Giá vốn phải lớn hơn 0');
    await tx.inventory.updateMany({ where: { productId: row.productId, ...(scope === 'allBranches' ? {} : { branchId: row.destinationBranchId }) }, data: { cost } });
    await tx.production.update({ where: { id: row.id }, data: { costAppliedAt: new Date(), appliedUnitCost: cost } });
  }

  async applyCost(id: number, cost: number, scope: string | undefined, expectedOldCost: number | undefined, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await this.locked(tx, id);
      if (row.status !== 2 || row.costAppliedAt) throw new BadRequestException('Chỉ áp giá vốn một lần cho phiếu đã hoàn thành');
      await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${row.productId} AND "branchId" = ${row.destinationBranchId} FOR UPDATE`;
      const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: row.productId, branchId: row.destinationBranchId } } });
      if (!inv) throw new BadRequestException('Không tìm thấy tồn kho thành phẩm');
      if (expectedOldCost != null && Math.abs(Number(inv.cost) - expectedOldCost) > 0.005) throw new ConflictException('Giá vốn đã thay đổi, vui lòng xem lại');
      await this.applyCostTx(tx, row, cost, scope);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    });
    await this.log('PRODUCTION_FACTORY_APPLY_COST', result, userId);
    return result;
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
