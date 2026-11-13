import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ManufacturersService } from './manufacturers.service';
import { CreateProductionDto } from '../productions/dto/create-production.dto';
import { ReceiveProductionDto } from '../productions/dto/production-factory.dto';
import { ManufacturerMaterialDto, OwnMaterialDto } from './dto';
import {
  ensureExternalCostSnapshot, externalCosts, materialAmount, money, ownConversion,
  planUnitCost, scaleSuppliedLine, slipQuantity,
} from './external-production.util';
import { normalizeNsxUnit } from '../common/nsx-pricing.util';
import { buildInventoryLogBase } from '../common/inventory-log.util';
import { computeWeightedAverageCost, ensureInventoryRow } from '../common/production-factory.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import { outputSpec } from '../productions/production-cost.util';

export const EXTERNAL_INCLUDE = {
  components: true, manufacturerMaterials: true,
  receipts: { orderBy: { seq: 'asc' as const } },
  manufacturer: { select: { id: true, code: true, name: true, supplierId: true } },
  supplier: { select: { id: true, code: true, name: true } },
} as const;

/** Đợt nhận còn hiệu lực / đã hủy. */
const RECEIPT_ACTIVE = 1;
const RECEIPT_CANCELLED = 2;

type Tx = Prisma.TransactionClient;
type ExternalRow = Prisma.ProductionGetPayload<{ include: typeof EXTERNAL_INCLUDE }>;
type Pair = { productId: number; branchId: number };

const D = (value: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(value ?? 0);
const day = (date: Date) => date.toISOString().slice(0, 10);
const vnd = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
const isLegacyLine = (line: { productId?: number | null; pricingMode?: string | null; priceUnit?: string | null }) =>
  !line.productId || line.pricingMode === 'TOTAL' || !line.priceUnit;

@Injectable()
export class ExternalProductionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manufacturers: ManufacturersService,
    private readonly audit: AuditLogsService,
  ) {}

  private async locked(tx: Tx, id: number): Promise<ExternalRow> {
    await tx.$queryRaw`SELECT id FROM productions WHERE id = ${id} FOR UPDATE`;
    const row = await tx.production.findUnique({ where: { id }, include: EXTERNAL_INCLUDE });
    if (!row?.manufacturerId) throw new NotFoundException('Không tìm thấy phiếu gửi sản xuất mới');
    return row;
  }

  private async materials(
    tx: Tx, own: OwnMaterialDto[], supplied: ManufacturerMaterialDto[], strict = false,
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

  /** Dòng NSX đã lưu (bảng hoặc JSON của đợt) → DTO, giữ priceUnit để tính lại đúng (300 g × đ/kg). */
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
    tx: Tx, requested: number | null | undefined, productId: number, existing?: any,
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
      const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId } });
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
      const materialValue = money(value);
      // Giá thành chốt lúc gửi: áp giá vốn được ngay, không chờ nhận đủ hàng.
      await ensureInventoryRow(tx, row.productId, row.destinationBranchId);
      await tx.production.update({ where: { id }, data: {
        status: 4, sentDate: date, supplierId: manufacturer.supplierId,
        materialValue, totalCost: money(value.add(row.totalPayable)),
        batchUnitCost: planUnitCost({ ...row, materialValue }),
        outputSpecSnapshot: { ...outputSpec(product) }, costSnapshotAt: new Date(),
      } });
      await recalcOnHandForPairs(tx, row.components.map((line) => ({ productId: line.componentProductId, branchId: row.sourceBranchId })));
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_SEND', result, userId);
    return result;
  }

  // ── Đợt nhận ─────────────────────────────────────────────────────────

  /** Nhận một đợt thành phẩm (phiếu Đã gửi / Nhận một phần). */
  async receive(id: number, dto: ReceiveProductionDto, userId: number) {
    if (dto.newCost != null || dto.costScope != null || dto.expectedOldCost != null || dto.expectedCosts != null) {
      throw new BadRequestException('Nhận hàng không áp giá vốn. Hãy dùng thao tác Áp dụng giá vốn');
    }
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      let row = await this.locked(tx, id);
      if (row.status !== 4 && row.status !== 5) throw new ConflictException('Chỉ nhận hàng cho phiếu đã gửi hoặc đang nhận một phần');
      await this.assertOutputProduct(tx, row.productId);
      row = { ...row, ...(await ensureExternalCostSnapshot(tx, row)) };
      const data = await this.receiptData(tx, row, dto);
      const userName = await this.actorName(tx, userId);
      const max = await tx.productionReceipt.aggregate({ where: { productionId: id }, _max: { seq: true } });
      const seq = (max._max.seq ?? 0) + 1;
      await this.lockOutput(tx, row);
      const receipt = await tx.productionReceipt.create({ data: {
        ...data, productionId: id, seq, code: `${row.code}-${seq}`, createdById: userId, createdByName: userName,
      } });
      await this.writeReceiptLog(tx, row, receipt, userId, userName);
      await this.syncReceipts(tx, id, dto.finish ? { closed: true, closedAt: data.receivedDate } : {});
      await recalcOnHandForPairs(tx, [this.outputPair(row)]);
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_RECEIVE', result, userId);
    return result;
  }

  /** Sửa một đợt đã nhận (kể cả khi phiếu đã hoàn thành). */
  async updateReceipt(id: number, receiptId: number, dto: ReceiveProductionDto, userId: number) {
    if (dto.newCost != null || dto.costScope != null || dto.expectedOldCost != null || dto.expectedCosts != null) {
      throw new BadRequestException('Sửa đợt nhận không áp giá vốn. Hãy dùng thao tác Áp dụng giá vốn');
    }
    await this.internal(userId);
    let changes: Record<string, unknown> = {};
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      let row = await this.ensureReceiptRows(tx, await this.locked(tx, id));
      if (![2, 4, 5].includes(row.status)) throw new ConflictException('Phiếu đã hủy hoặc chưa gửi');
      // receiptId 0 = lần nhận của phiếu cũ (vừa chuyển thành "Đợt 1").
      const receipt = row.receipts.find((item) => (receiptId === 0 ? item.seq === 1 : item.id === receiptId));
      if (!receipt) throw new NotFoundException('Không tìm thấy đợt nhận');
      if (receipt.status !== RECEIPT_ACTIVE) throw new ConflictException('Đợt nhận đã hủy');
      await this.assertOutputProduct(tx, row.productId);
      row = { ...row, ...(await ensureExternalCostSnapshot(tx, row)) };
      const data = await this.receiptData(tx, row, dto, receipt);
      const userName = await this.actorName(tx, userId);
      await this.lockOutput(tx, row);
      const updated = await tx.productionReceipt.update({ where: { id: receipt.id }, data: { ...data, updatedByName: userName } });
      await this.writeReceiptLog(tx, row, updated, userId, userName);
      await this.syncReceipts(tx, id, dto.finish ? { closed: true, closedAt: data.receivedDate } : {});
      await recalcOnHandForPairs(tx, [this.outputPair(row)]);
      await this.assertStock(tx, [this.outputPair(row)], () => 'Thành phẩm của đợt này đã được xuất tiếp, không thể giảm số lượng nhận');
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      changes = {
        receipt: receipt.code,
        quantity: { from: Number(receipt.quantity), to: data.quantity.toNumber() },
        totalPayable: { from: Number(receipt.totalPayable), to: data.totalPayable },
        receivedDate: { from: receipt.receivedDate, to: data.receivedDate },
      };
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_RECEIPT_UPDATE', result, userId, changes);
    return result;
  }

  /** Hủy một đợt nhận: trừ lại tồn thành phẩm, giảm nợ NSX, mở lại phiếu. */
  async cancelReceipt(id: number, receiptId: number, userId: number) {
    await this.internal(userId);
    let code = '';
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.ensureReceiptRows(tx, await this.locked(tx, id));
      if (![2, 4, 5].includes(row.status)) throw new ConflictException('Phiếu đã hủy hoặc chưa gửi');
      // receiptId 0 = lần nhận của phiếu cũ (vừa chuyển thành "Đợt 1").
      const receipt = row.receipts.find((item) => (receiptId === 0 ? item.seq === 1 : item.id === receiptId));
      if (!receipt) throw new NotFoundException('Không tìm thấy đợt nhận');
      if (receipt.status !== RECEIPT_ACTIVE) throw new ConflictException('Đợt nhận đã hủy');
      code = receipt.code;
      await this.lockOutput(tx, row);
      await tx.productionReceipt.update({ where: { id: receipt.id }, data: {
        status: RECEIPT_CANCELLED, cancelledAt: new Date(), cancelledByName: await this.actorName(tx, userId),
      } });
      // Hủy đợt nào cũng mở lại phiếu (đợt bị hủy có thể chính là đợt kết thúc).
      await this.syncReceipts(tx, id, { closed: false });
      await recalcOnHandForPairs(tx, [this.outputPair(row)]);
      await this.assertStock(tx, [this.outputPair(row)], () => 'Thành phẩm của đợt này đã được xuất tiếp, không thể hủy đợt nhận');
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_RECEIPT_CANCEL', result, userId, { receipt: code });
    return result;
  }

  /** Kết thúc nhận hàng khi NSX không trả thêm (phần còn thiếu coi là hao hụt). */
  async closeReceiving(id: number, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.locked(tx, id);
      if (row.status !== 5) throw new ConflictException('Chỉ kết thúc được phiếu đang nhận một phần');
      await this.syncReceipts(tx, id, { closed: true, closedAt: new Date() });
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_RECEIVING_CLOSE', result, userId);
    return result;
  }

  /** Mở lại phiếu đã kết thúc sớm để nhận tiếp. */
  async reopenReceiving(id: number, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.ensureReceiptRows(tx, await this.locked(tx, id));
      if (row.status !== 2) throw new ConflictException('Chỉ mở lại được phiếu đã hoàn thành');
      if (D(row.receivedQuantity).gte(row.quantity)) {
        throw new BadRequestException('Phiếu đã nhận đủ sản lượng dự kiến. Muốn nhận thêm hãy sửa phiếu, tăng sản lượng dự kiến');
      }
      await this.syncReceipts(tx, id, { closed: false });
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_RECEIVING_REOPEN', result, userId);
    return result;
  }

  // ── Sửa phiếu đã gửi ─────────────────────────────────────────────────

  /**
   * Sửa phiếu Đã gửi / Nhận một phần / Hoàn thành. Không đổi NSX, thành phẩm,
   * kho; tiền tệ khóa khi đã có đợt nhận. Ghi lại xuất kho nguyên liệu mình
   * (giữ giá vốn chụp lúc gửi), dự kiến NSX/phí, giá thành dự kiến.
   */
  async updateSent(id: number, dto: CreateProductionDto & { sentDate?: string | Date | null }, userId: number) {
    await this.internal(userId);
    let changes: Record<string, unknown> = {};
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, id);
      const row = await this.ensureReceiptRows(tx, await this.locked(tx, id));
      if (![2, 4, 5].includes(row.status)) throw new BadRequestException('Phiếu đã hủy, không thể chỉnh sửa');
      const changed = (next: number | undefined, current: number | null) => next != null && next !== current;
      if (changed(dto.manufacturerId, row.manufacturerId) || changed(dto.productId, row.productId)
        || changed(dto.sourceBranchId, row.sourceBranchId) || changed(dto.destinationBranchId, row.destinationBranchId)) {
        throw new BadRequestException('Phiếu đã gửi không đổi được nhà sản xuất, thành phẩm hoặc kho. Hãy hủy phiếu và tạo lại');
      }
      const active = row.receipts.filter((item) => item.status === RECEIPT_ACTIVE);
      const currency = dto.feeCurrency ?? row.feeCurrency;
      if (currency !== row.feeCurrency && active.length) throw new BadRequestException('Phiếu đã có đợt nhận, không đổi được tiền tệ');
      const quantity = Number(dto.quantity);
      if (!(quantity > 0)) throw new BadRequestException('Sản lượng phải lớn hơn 0');
      const sentDate = dto.sentDate ? new Date(dto.sentDate) : row.sentDate ?? new Date();
      if (active.some((item) => day(item.receivedDate) < day(sentDate))) {
        throw new BadRequestException('Ngày gửi không được sau ngày nhận của các đợt');
      }
      const own = dto.ownMaterials ?? [];
      const supplied = dto.manufacturerMaterials ?? [];
      // Phiếu còn dòng NSX cũ (không mã / "Tổng tiền") thì không kiểm tra chặt để vẫn sửa được.
      const rows = await this.materials(tx, own, supplied, !row.manufacturerMaterials.some(isLegacyLine));
      if (!rows.own.length && !rows.supplied.length) throw new BadRequestException('Vui lòng nhập nguyên liệu');
      const formula = await this.resolveFormula(tx, dto.formulaId, row.productId, row);
      const rate = currency === 'CNY' ? dto.feeExchangeRate ?? Number(row.feeExchangeRate ?? 1) : 1;
      const fee = currency === 'CNY' ? dto.feeForeignAmount ?? 0 : dto.processingFee ?? 0;
      const costs = externalCosts(supplied, fee, currency, rate);

      // Nguyên liệu mình: giữ giá vốn chụp lúc gửi theo sản phẩm, dòng mới lấy giá vốn hiện tại.
      const oldUnits = new Map<number, Prisma.Decimal>();
      const oldCost = new Map<number, Prisma.Decimal>();
      for (const line of row.components) {
        oldUnits.set(line.componentProductId, D(oldUnits.get(line.componentProductId)).add(line.unitsDeducted));
        if (line.unitCost != null) oldCost.set(line.componentProductId, D(line.unitCost));
      }
      const productIds = [...new Set([...row.components.map((line) => line.componentProductId), ...rows.own.map((line) => line.componentProductId)])]
        .sort((a, b) => a - b);
      for (const productId of productIds) {
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${productId} AND "branchId" = ${row.sourceBranchId} FOR UPDATE`;
      }
      const userName = await this.actorName(tx, userId);
      const newUnits = new Map<number, Prisma.Decimal>();
      let value = new Prisma.Decimal(0);
      const components: Array<Omit<(typeof rows.own)[number], 'unitsDeducted' | 'unitCost'> & { unitsDeducted: Prisma.Decimal; unitCost: Prisma.Decimal }> = [];
      for (const line of rows.own) {
        const units = D(line.actualGrams).mul(line.conversionFactor ?? 1).toDecimalPlaces(4);
        if (!units.gt(0)) throw new BadRequestException(`Lượng gửi quá nhỏ sau quy đổi: ${line.componentName}`);
        let unitCost = oldCost.get(line.componentProductId);
        if (unitCost == null) {
          const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: line.componentProductId, branchId: row.sourceBranchId } } });
          if (!inv) throw new BadRequestException(`Không đủ tồn kho: ${line.componentName}`);
          unitCost = D(inv.cost);
        }
        value = value.add(units.mul(unitCost));
        newUnits.set(line.componentProductId, D(newUnits.get(line.componentProductId)).add(units));
        components.push({ ...line, unitsDeducted: units, unitCost });
      }
      await tx.inventoryLog.deleteMany({ where: { refType: 'production', refId: id, transactionType: 'PRODUCTION_OUT' } });
      for (const line of components) {
        await tx.inventoryLog.create({ data: {
          productId: line.componentProductId, productCode: line.componentCode, productName: line.componentName,
          branchId: row.sourceBranchId, branchName: row.sourceBranchName, transactionType: 'PRODUCTION_OUT',
          refType: 'production', refId: id, refCode: row.code, quantity: line.unitsDeducted.negated(), costPrice: line.unitCost,
          transactionDate: sentDate, ...buildInventoryLogBase({ userId, userName }),
        } });
      }
      await tx.productionComponent.deleteMany({ where: { productionId: id } });
      if (components.length) await tx.productionComponent.createMany({ data: components.map((line) => ({ ...line, productionId: id })) });
      await tx.productionManufacturerMaterial.deleteMany({ where: { productionId: id } });
      if (rows.supplied.length) await tx.productionManufacturerMaterial.createMany({ data: rows.supplied.map((line) => ({ ...line, productionId: id })) });
      const sourcePairs = productIds.map((productId) => ({ productId, branchId: row.sourceBranchId }));
      await recalcOnHandForPairs(tx, sourcePairs);
      await this.assertStock(
        tx,
        sourcePairs.filter((pair) => D(newUnits.get(pair.productId)).gt(D(oldUnits.get(pair.productId)))),
        (name) => `Không đủ tồn kho: ${name}`,
      );

      // Giá thành dự kiến chỉ tính lại khi đầu vào đổi (phiếu cũ giữ giá thành lúc nhận).
      const materialValue = money(value);
      const inputsChanged = !D(row.materialValue).equals(materialValue) || !D(row.quantity).equals(quantity)
        || !D(row.processingFee).add(row.manufacturerMaterialCost).equals(costs.totalPayable);
      const batchUnitCost = inputsChanged || row.batchUnitCost == null
        ? planUnitCost({ materialValue, processingFee: costs.processingFee, manufacturerMaterialCost: costs.manufacturerMaterialCost, quantity })
        : row.batchUnitCost;
      const costChanged = row.batchUnitCost == null || !D(row.batchUnitCost).equals(batchUnitCost);
      const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId } });
      await tx.production.update({ where: { id }, data: {
        quantity, note: dto.note ?? null, ...formula,
        feeCurrency: currency, feeForeignAmount: currency === 'CNY' ? fee : null,
        feeExchangeRate: currency === 'CNY' ? rate : null,
        processingFee: costs.processingFee, manufacturerMaterialCost: costs.manufacturerMaterialCost,
        materialValue, sentDate, batchUnitCost,
        costSnapshotAt: costChanged || !row.costSnapshotAt ? new Date() : row.costSnapshotAt,
        outputSpecSnapshot: (row.outputSpecSnapshot ?? { ...outputSpec(product) }) as Prisma.InputJsonValue,
        // Giá thành đổi sau khi đã áp giá → bỏ dấu "đã áp" để áp lại (lần áp cũ nằm trong audit log).
        ...(row.costAppliedAt && costChanged ? {
          costAppliedAt: null, appliedUnitCost: null, costAppliedById: null, costAppliedByName: null,
          costAppliedScope: null, costApplicationSnapshot: Prisma.DbNull,
        } : {}),
      } });
      await this.syncReceipts(tx, id);
      if (row.supplierId) await recalcSupplierDebt(tx, row.supplierId);
      changes = {
        quantity: { from: Number(row.quantity), to: quantity },
        materialValue: { from: Number(row.materialValue), to: materialValue },
        plannedPayable: { from: Number(D(row.processingFee).add(row.manufacturerMaterialCost)), to: costs.totalPayable },
        batchUnitCost: { from: row.batchUnitCost == null ? null : Number(row.batchUnitCost), to: Number(batchUnitCost) },
        costApplicationReset: !!(row.costAppliedAt && costChanged),
        previousCostApplication: row.costAppliedAt ? {
          at: row.costAppliedAt, unitCost: row.appliedUnitCost, by: row.costAppliedByName, scope: row.costAppliedScope,
        } : null,
      };
      return tx.production.findUniqueOrThrow({ where: { id }, include: EXTERNAL_INCLUDE });
    }, { timeout: 60000 });
    await this.log('PRODUCTION_FACTORY_UPDATE', result, userId, changes);
    return result;
  }

  async preview(id: number, quantity?: number, processingFee?: number) {
    const row = await this.prisma.production.findUnique({ where: { id }, include: EXTERNAL_INCLUDE });
    if (!row || ![2, 4, 5].includes(row.status)) throw new BadRequestException('Chỉ xem giá thành phiếu đã gửi hoặc đã nhận');
    const planned = Number(row.quantity);
    const received = Number(row.receivedQuantity ?? 0);
    const fee = processingFee ?? Number(row.processingFee);
    const totalPayable = Number(row.manufacturerMaterialCost) + fee;
    const totalCost = Number(row.materialValue) + totalPayable;
    const unitCost = row.batchUnitCost != null && processingFee == null
      ? Number(row.batchUnitCost)
      : planned > 0 ? totalCost / planned : 0;
    const displayQuantity = quantity ?? planned;
    const inventories = await this.prisma.inventory.findMany({ where: { productId: row.productId } });
    const inv = inventories.find((item) => item.branchId === row.destinationBranchId);
    const onHand = Number(inv?.onHand ?? 0), oldCost = Number(inv?.cost ?? 0);
    return {
      productionId: id, productName: row.productName, receiveBranchId: row.destinationBranchId,
      receiveBranchName: row.destinationBranchName, materialValue: Number(row.materialValue),
      manufacturerMaterialCost: Number(row.manufacturerMaterialCost), processingFee: fee,
      totalCost, totalPayable, receivedQuantity: displayQuantity,
      unitCost, onHand, oldCost, branchCount: inventories.length,
      ...computeWeightedAverageCost({ otherQuantity: Math.max(0, onHand - received), oldCost, receivedQuantity: displayQuantity, unitCost }),
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
      const pairs = [...row.components.map((line) => ({ productId: line.componentProductId, branchId: row.sourceBranchId })), this.outputPair(row)];
      for (const key of [...new Set(pairs.map((pair) => `${pair.productId}:${pair.branchId}`))].sort()) {
        const [productId, branchId] = key.split(':').map(Number);
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${productId} AND "branchId" = ${branchId} FOR UPDATE`;
      }
      await tx.production.update({ where: { id }, data: { status: 3, debtAmount: 0 } });
      await tx.productionReceipt.updateMany({
        where: { productionId: id, status: RECEIPT_ACTIVE },
        data: { status: RECEIPT_CANCELLED, cancelledAt: new Date(), cancelledByName: await this.actorName(tx, userId) },
      });
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

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Dữ liệu một đợt nhận. Bỏ trống thì: SL = còn lại; dòng NSX và phí chia từ
   * dự kiến theo SL đợt / SL dự kiến (khi sửa: giữ giá trị đang lưu của đợt).
   */
  private async receiptData(tx: Tx, row: ExternalRow, dto: ReceiveProductionDto, existing?: ExternalRow['receipts'][number]) {
    const planned = D(row.quantity);
    const others = row.receipts
      .filter((item) => item.status === RECEIPT_ACTIVE && item.id !== existing?.id)
      .reduce((sum, item) => sum.add(item.quantity), new Prisma.Decimal(0));
    const remaining = Prisma.Decimal.max(planned.sub(others), 0);
    const quantity = D(dto.receivedQuantity ?? existing?.quantity ?? remaining).toDecimalPlaces(4);
    if (!quantity.gt(0)) throw new BadRequestException('Số lượng nhận phải lớn hơn 0');
    const receivedDate = dto.completedDate ? new Date(dto.completedDate) : existing?.receivedDate ?? new Date();
    if (row.sentDate && day(receivedDate) < day(row.sentDate)) throw new BadRequestException('Ngày nhận không được trước ngày gửi');
    const ratio = planned.gt(0) ? quantity.div(planned) : new Prisma.Decimal(1);
    const cny = row.feeCurrency === 'CNY';
    const supplied = dto.manufacturerMaterials
      ?? (existing
        ? ExternalProductionsService.suppliedFromRows((existing.manufacturerMaterials as any[]) ?? [])
        : ExternalProductionsService.suppliedFromRows(row.manufacturerMaterials).map((line) => scaleSuppliedLine(line, ratio)));
    const rows = await this.materials(tx, [], supplied);
    const rate = dto.feeExchangeRate ?? Number(existing?.feeExchangeRate ?? row.feeExchangeRate ?? 1);
    const plannedFee = cny ? Number(row.feeForeignAmount ?? 0) : Number(row.processingFee);
    const storedFee = existing ? Number(cny ? existing.feeForeignAmount ?? 0 : existing.processingFee) : money(ratio.mul(plannedFee));
    const fee = (cny ? dto.feeForeignAmount : dto.processingFee) ?? storedFee;
    const costs = externalCosts(supplied, fee, row.feeCurrency, rate);
    return {
      quantity, receivedDate,
      note: dto.note !== undefined ? dto.note?.trim() || null : existing?.note ?? null,
      processingFee: costs.processingFee,
      feeForeignAmount: cny ? fee : null,
      feeExchangeRate: cny ? rate : null,
      manufacturerMaterialCost: costs.manufacturerMaterialCost,
      totalPayable: costs.totalPayable,
      totalForeignPayable: costs.totalForeignPayable,
      manufacturerMaterials: rows.supplied as Prisma.InputJsonValue,
    };
  }

  /** Log nhập kho của một đợt: xóa log cũ của đợt rồi ghi lại. */
  private async writeReceiptLog(
    tx: Tx, row: ExternalRow, receipt: { id: number; seq: number; code: string; quantity: Prisma.Decimal; receivedDate: Date },
    userId: number, userName: string,
  ) {
    await tx.inventoryLog.deleteMany({ where: { refType: 'production_receipt', refId: receipt.id } });
    await tx.inventoryLog.create({ data: {
      productId: row.productId, productCode: row.productCode, productName: row.productName,
      branchId: row.destinationBranchId, branchName: row.destinationBranchName,
      // refCode = mã phiếu gửi để link trên thẻ kho mở đúng phiếu.
      transactionType: 'PRODUCTION_IN', refType: 'production_receipt', refId: receipt.id, refCode: row.code,
      quantity: receipt.quantity, costPrice: row.batchUnitCost ?? planUnitCost(row),
      transactionDate: receipt.receivedDate, note: `Nhận đợt ${receipt.seq} (${receipt.code})`,
      ...buildInventoryLogBase({ userId, userName }),
    } });
  }

  /**
   * Cộng các đợt còn hiệu lực vào phiếu và đặt trạng thái:
   * không còn đợt → 4; đủ dự kiến hoặc đã kết thúc → 2; còn lại → 5.
   * Chặn khi đã trả NSX nhiều hơn số phải trả mới.
   */
  private async syncReceipts(tx: Tx, id: number, opts: { closed?: boolean; closedAt?: Date } = {}) {
    const row = await tx.production.findUniqueOrThrow({ where: { id }, include: { manufacturerMaterials: true } });
    const [receipts, paid] = await Promise.all([
      tx.productionReceipt.findMany({ where: { productionId: id, status: RECEIPT_ACTIVE }, orderBy: { seq: 'asc' } }),
      tx.payableAllocation.aggregate({ where: { productionId: id, status: 1 }, _sum: { settledAmount: true } }),
    ]);
    const paidAmount = money(paid._sum.settledAmount ?? 0);
    if (!receipts.length) {
      if (paidAmount > 0.005) throw new BadRequestException('Phiếu đã có thanh toán NSX. Hãy hủy thanh toán trước khi hủy hết các đợt nhận');
      const plan = this.planPayable(row);
      return tx.production.update({ where: { id }, data: {
        status: 4, receivedQuantity: null, completedDate: null, receivingClosed: false,
        paidAmount, debtAmount: 0, ...plan,
        totalCost: money(D(row.materialValue).add(plan.totalPayable)),
      } });
    }
    const sum = (pick: (item: (typeof receipts)[number]) => Prisma.Decimal.Value | null) =>
      receipts.reduce((total, item) => total.add(pick(item) ?? 0), new Prisma.Decimal(0));
    const received = sum((item) => item.quantity).toDecimalPlaces(4);
    const totalPayable = money(sum((item) => item.totalPayable));
    const totalForeignPayable = row.feeCurrency === 'CNY' ? money(sum((item) => item.totalForeignPayable)) : null;
    if (paidAmount - totalPayable > 0.005) {
      throw new BadRequestException(`Đã trả NSX ${vnd(paidAmount)} đ, lớn hơn số phải trả mới ${vnd(totalPayable)} đ. Hãy hủy bớt thanh toán trước`);
    }
    const closed = opts.closed ?? row.receivingClosed;
    const full = received.gte(row.quantity);
    const done = full || closed;
    const lastDate = receipts.reduce((latest, item) => (item.receivedDate > latest ? item.receivedDate : latest), receipts[0].receivedDate);
    const completedDate = !done ? null
      : full ? lastDate
      : opts.closedAt ?? (row.status === 2 && row.completedDate ? row.completedDate : new Date());
    return tx.production.update({ where: { id }, data: {
      status: done ? 2 : 5, receivedQuantity: received, completedDate, receivingClosed: done && closed,
      totalPayable, totalForeignPayable, paidAmount, debtAmount: money(totalPayable - paidAmount),
      totalCost: money(D(row.materialValue).add(totalPayable)),
    } });
  }

  /** Phải trả NSX dự kiến của phiếu (khi chưa có đợt nhận). */
  private planPayable(row: { feeCurrency: string; feeForeignAmount: Prisma.Decimal | null; processingFee: Prisma.Decimal; manufacturerMaterialCost: Prisma.Decimal; feeExchangeRate: Prisma.Decimal | null; totalForeignPayable: Prisma.Decimal | null; manufacturerMaterials: any[] }) {
    try {
      const fee = row.feeCurrency === 'CNY' ? Number(row.feeForeignAmount ?? 0) : Number(row.processingFee);
      const costs = externalCosts(ExternalProductionsService.suppliedFromRows(row.manufacturerMaterials), fee, row.feeCurrency, Number(row.feeExchangeRate ?? 1));
      return { totalPayable: costs.totalPayable, totalForeignPayable: costs.totalForeignPayable };
    } catch {
      return {
        totalPayable: money(D(row.processingFee).add(row.manufacturerMaterialCost)),
        totalForeignPayable: row.totalForeignPayable == null ? null : Number(row.totalForeignPayable),
      };
    }
  }

  /**
   * Phiếu hoàn thành trước khi có đợt nhận: chuyển lần nhận cũ thành "Đợt 1"
   * (tạo dòng đợt từ dữ liệu phiếu, đổi log nhập kho sang đợt). Tồn kho và
   * công nợ không đổi.
   */
  private async ensureReceiptRows(tx: Tx, row: ExternalRow): Promise<ExternalRow> {
    if (row.status !== 2 || row.receipts.length || row.receivedQuantity == null) return row;
    const receipt = await tx.productionReceipt.create({ data: {
      productionId: row.id, seq: 1, code: `${row.code}-1`, status: RECEIPT_ACTIVE,
      receivedDate: row.completedDate ?? row.updatedAt, quantity: row.receivedQuantity,
      processingFee: row.processingFee, feeForeignAmount: row.feeForeignAmount, feeExchangeRate: row.feeExchangeRate,
      manufacturerMaterialCost: row.manufacturerMaterialCost, totalPayable: row.totalPayable,
      totalForeignPayable: row.totalForeignPayable,
      manufacturerMaterials: row.manufacturerMaterials.map((line) => ({
        productId: line.productId, productCode: line.productCode, description: line.description,
        quantity: line.quantity == null ? null : Number(line.quantity), unit: line.unit,
        pricingMode: line.pricingMode, unitPrice: Number(line.unitPrice), priceUnit: line.priceUnit,
        amount: Number(line.amount),
      })),
      createdById: row.createdById, createdByName: row.createdByName,
    } });
    await tx.inventoryLog.updateMany({
      where: { refType: 'production', refId: row.id, transactionType: 'PRODUCTION_IN' },
      data: { refType: 'production_receipt', refId: receipt.id },
    });
    await tx.production.update({ where: { id: row.id }, data: { receivingClosed: D(row.receivedQuantity).lt(row.quantity) } });
    return tx.production.findUniqueOrThrow({ where: { id: row.id }, include: EXTERNAL_INCLUDE });
  }

  private outputPair(row: { productId: number; destinationBranchId: number }): Pair {
    return { productId: row.productId, branchId: row.destinationBranchId };
  }

  private async lockOutput(tx: Tx, row: { productId: number; destinationBranchId: number }) {
    await ensureInventoryRow(tx, row.productId, row.destinationBranchId);
    await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${row.productId} AND "branchId" = ${row.destinationBranchId} FOR UPDATE`;
  }

  private async assertOutputProduct(tx: Tx, productId: number) {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    if (![2, 4].includes(product.type)) throw new BadRequestException('Thành phẩm không còn là hàng hóa quản lý tồn');
  }

  /** Sau khi tính lại tồn: chặn khi một cặp sản phẩm/kho bị âm. */
  private async assertStock(tx: Tx, pairs: Pair[], message: (name: string) => string) {
    for (const pair of pairs) {
      const inv = await tx.inventory.findUnique({ where: { productId_branchId: pair } });
      if (inv && Number(inv.onHand) < -0.00005) throw new BadRequestException(message(inv.productName));
    }
  }

  private async actorName(tx: Tx, userId: number) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    return user?.name ?? user?.email ?? 'System';
  }

  private async log(actionCode: string, row: any, userId: number, changes?: Record<string, unknown>) {
    await this.audit.create({
      actionType: 'POST', actionCode, entityType: 'productions', entityId: String(row.id),
      entityCode: row.code, message: `${actionCode}: ${row.code}`, userId, userName: row.createdByName,
      branchId: row.sourceBranchId, snapshot: JSON.parse(JSON.stringify(changes ? { ...row, changes } : row)),
    });
  }

  private async lockAccount(tx: Tx, id: number) {
    const row = await tx.production.findUnique({ where: { id }, select: { supplierId: true, manufacturerId: true } });
    if (row?.supplierId) await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${row.supplierId} FOR UPDATE`;
    else if (row?.manufacturerId) await tx.$queryRaw`SELECT id FROM manufacturers WHERE id = ${row.manufacturerId} FOR UPDATE`;
  }

  private async internal(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { supplierId: true } });
    if (user?.supplierId) throw new ForbiddenException('Luồng gửi sản xuất chỉ dành cho nhân viên nội bộ');
  }
}
