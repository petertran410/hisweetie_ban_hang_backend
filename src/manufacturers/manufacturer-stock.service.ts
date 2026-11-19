import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { buildInventoryLogBase } from '../common/inventory-log.util';
import { ensureInventoryRow } from '../common/production-factory.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { documentDate, gramsPerStockUnit, money, ownConversion, shortage, stockOf } from './external-production.util';
import {
  assertManufacturerStock, balanceOf, CONSUMING_STATUSES, manufacturerStock, SOURCE_MANUFACTURER,
  STOCK_SLIP_ACTIVE, STOCK_SLIP_CANCELLED, STOCK_SLIP_LABEL, STOCK_SLIP_TYPES, StockSlipType,
} from './manufacturer-stock.util';
import { ManufacturerStockSlipDto } from './manufacturer-stock.dto';

type Tx = Prisma.TransactionClient;
const D = (value: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(value ?? 0);
const EPSILON = 0.00005;

/** refType của InventoryLog ghi ở kho mình (gửi đi / nhận lại). */
export const MANUFACTURER_STOCK_REF = 'manufacturer_stock';
const LOG_TYPE: Record<Exclude<StockSlipType, 'ADJUST'>, string> = {
  SEND: 'MANUFACTURER_STOCK_OUT', RETURN: 'MANUFACTURER_STOCK_IN',
};
const CODE_PREFIX: Record<StockSlipType, string> = { SEND: 'GNL', RETURN: 'TNL', ADJUST: 'DCN' };
const DATE_LABEL: Record<StockSlipType, string> = { SEND: 'Ngày gửi', RETURN: 'Ngày trả', ADJUST: 'Ngày điều chỉnh' };

export const STOCK_SLIP_INCLUDE = {
  lines: { orderBy: { id: 'asc' as const } },
  manufacturer: { select: { id: true, code: true, name: true, contactNumber: true, address: true } },
} as const;
type SlipRow = Prisma.ManufacturerStockSlipGetPayload<{ include: typeof STOCK_SLIP_INCLUDE }>;

/**
 * Phiếu nguyên liệu tại NSX: Gửi (trừ kho mình, cộng tồn NSX), Trả (trừ tồn NSX,
 * cộng kho mình), Điều chỉnh (đặt lại tồn NSX theo thực tế; chênh lệch = hao hụt).
 * Lưu là có hiệu lực; sửa được, hủy được. Không phát sinh công nợ.
 */
@Injectable()
export class ManufacturerStockService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditLogsService) {}

  // ── Đọc ──────────────────────────────────────────────────────────────

  /** Tồn từng mã tại NSX, kèm giá BQ và giá trị (mã đã về 0 vẫn trả để xem lịch sử). */
  async list(manufacturerId: number) {
    await this.manufacturerOrThrow(manufacturerId);
    const stock = await manufacturerStock(this.prisma, manufacturerId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...stock.keys()] } },
      select: { id: true, code: true, name: true, unit: true, weight: true, weightUnit: true },
    });
    const data = products.map((product) => {
      const row = balanceOf(stock, product.id);
      return {
        productId: product.id, productCode: product.code, productName: product.name, unit: product.unit,
        gramsPerUnit: gramsPerStockUnit(product), units: row.units.toNumber(), avgCost: row.avgCost.toNumber(),
        value: row.units.gt(EPSILON) ? money(row.units.mul(row.avgCost)) : 0,
      };
    }).sort((a, b) => a.productCode.localeCompare(b.productCode));
    return { data, totalValue: money(data.reduce((sum, row) => sum + row.value, 0)) };
  }

  /** Thẻ kho tại NSX của một mã: phiếu nguyên liệu + phiếu gửi SX dùng tồn, mới nhất trước. */
  async moves(manufacturerId: number, productId: number) {
    await this.manufacturerOrThrow(manufacturerId);
    const [lines, components] = await Promise.all([
      this.prisma.manufacturerStockSlipLine.findMany({
        where: { productId, slip: { manufacturerId, status: STOCK_SLIP_ACTIVE } },
        include: { slip: { select: { id: true, code: true, type: true, date: true, branchName: true, createdAt: true } } },
      }),
      this.prisma.productionComponent.findMany({
        where: {
          componentProductId: productId, source: SOURCE_MANUFACTURER,
          production: { manufacturerId, status: { in: CONSUMING_STATUSES } },
        },
        select: {
          unitsDeducted: true, unitCost: true,
          production: { select: { id: true, code: true, sentDate: true, createdAt: true, productName: true } },
        },
      }),
    ]);
    const rows = [
      ...lines.map((line) => ({
        kind: 'slip' as const, type: line.slip.type, refId: line.slip.id, refCode: line.slip.code,
        date: line.slip.date, createdAt: line.slip.createdAt,
        description: STOCK_SLIP_LABEL[line.slip.type as StockSlipType] + (line.slip.branchName ? ` · ${line.slip.branchName}` : ''),
        units: Number(line.units), unitCost: Number(line.unitCost),
      })),
      ...components.map((line) => ({
        kind: 'production' as const, type: 'PRODUCTION', refId: line.production.id, refCode: line.production.code,
        date: line.production.sentDate ?? line.production.createdAt, createdAt: line.production.createdAt,
        description: `Sản xuất ${line.production.productName}`,
        units: -Number(line.unitsDeducted), unitCost: Number(line.unitCost ?? 0),
      })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    let balance = new Prisma.Decimal(0);
    const data = rows.map((row) => {
      balance = balance.add(row.units);
      const { createdAt, ...rest } = row;
      void createdAt;
      return { ...rest, balanceAfter: balance.toDecimalPlaces(4).toNumber() };
    });
    return { data: data.reverse() };
  }

  async slips(manufacturerId: number, type?: string) {
    await this.manufacturerOrThrow(manufacturerId);
    if (type && !STOCK_SLIP_TYPES.includes(type as StockSlipType)) throw new BadRequestException('Loại phiếu không hợp lệ');
    return this.prisma.manufacturerStockSlip.findMany({
      where: { manufacturerId, ...(type ? { type } : {}) },
      include: STOCK_SLIP_INCLUDE,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  async findOne(id: number) {
    const slip = await this.prisma.manufacturerStockSlip.findUnique({ where: { id }, include: STOCK_SLIP_INCLUDE });
    if (!slip) throw new NotFoundException('Không tìm thấy phiếu nguyên liệu NSX');
    return slip;
  }

  async findByCode(code: string) {
    const slip = await this.prisma.manufacturerStockSlip.findUnique({
      where: { code }, select: { id: true, code: true, manufacturerId: true, manufacturer: { select: { code: true } } },
    });
    if (!slip) throw new NotFoundException('Không tìm thấy phiếu nguyên liệu NSX');
    return slip;
  }

  // ── Ghi ──────────────────────────────────────────────────────────────

  async create(manufacturerId: number, dto: ManufacturerStockSlipDto, userId: number) {
    await this.internal(userId);
    const type = dto.type;
    if (!type) throw new BadRequestException('Vui lòng chọn loại phiếu');
    const result = await this.prisma.$transaction(async (tx) => {
      const manufacturer = await this.lockManufacturer(tx, manufacturerId);
      if (!manufacturer.isActive) throw new BadRequestException('Nhà sản xuất đã ngừng hoạt động');
      return this.write(tx, { manufacturerId, manufacturerName: manufacturer.name, type, dto, userId });
    }, { timeout: 60000 });
    await this.log('MANUFACTURER_STOCK_CREATE', result, userId);
    return result;
  }

  async update(id: number, dto: ManufacturerStockSlipDto, userId: number) {
    await this.internal(userId);
    let before: SlipRow | undefined;
    const result = await this.prisma.$transaction(async (tx) => {
      const slip = await this.lockSlip(tx, id);
      before = slip;
      if (slip.status !== STOCK_SLIP_ACTIVE) throw new BadRequestException('Phiếu đã hủy, không thể chỉnh sửa');
      if (dto.type && dto.type !== slip.type) throw new BadRequestException('Không đổi được loại phiếu. Hãy hủy phiếu và tạo lại');
      if (dto.branchId !== undefined && (dto.branchId ?? null) !== slip.branchId) {
        throw new BadRequestException('Không đổi được kho của phiếu. Hãy hủy phiếu và tạo lại');
      }
      const manufacturer = await this.lockManufacturer(tx, slip.manufacturerId);
      return this.write(tx, {
        manufacturerId: slip.manufacturerId, manufacturerName: manufacturer.name,
        type: slip.type as StockSlipType, dto, userId, existing: slip,
      });
    }, { timeout: 60000 });
    await this.log('MANUFACTURER_STOCK_UPDATE', result, userId, {
      totalValue: { from: Number(before!.totalValue), to: Number(result.totalValue) },
      lines: {
        from: before!.lines.map((line) => ({ productId: line.productId, units: Number(line.units) })),
        to: result.lines.map((line) => ({ productId: line.productId, units: Number(line.units) })),
      },
    });
    return result;
  }

  async cancel(id: number, userId: number) {
    await this.internal(userId);
    const result = await this.prisma.$transaction(async (tx) => {
      const slip = await this.lockSlip(tx, id);
      if (slip.status !== STOCK_SLIP_ACTIVE) throw new BadRequestException('Phiếu đã hủy');
      await this.lockManufacturer(tx, slip.manufacturerId);
      const pairs = slip.branchId
        ? [...new Set(slip.lines.map((line) => line.productId))].sort((a, b) => a - b).map((productId) => ({ productId, branchId: slip.branchId! }))
        : [];
      for (const pair of pairs) {
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${pair.productId} AND "branchId" = ${pair.branchId} FOR UPDATE`;
      }
      await tx.manufacturerStockSlip.update({
        where: { id },
        data: { status: STOCK_SLIP_CANCELLED, cancelledAt: new Date(), cancelledByName: await this.actorName(tx, userId) },
      });
      if (pairs.length) {
        await recalcOnHandForPairs(tx, pairs);
        if (slip.type === 'RETURN') {
          await this.assertBranchStock(tx, pairs, (name) => `Nguyên liệu "${name}" nhận lại đã được xuất tiếp ở ${slip.branchName}, không thể hủy phiếu`);
        }
      }
      await assertManufacturerStock(
        tx, slip.manufacturerId, slip.lines.map((line) => line.productId),
        (name, missing, unit) => `Không hủy được: "${name}" đã được dùng cho phiếu sản xuất hoặc trả về kho (tồn tại NSX sẽ âm ${missing} ${unit}). Hãy sửa / hủy các phiếu đó trước`,
      );
      return tx.manufacturerStockSlip.findUniqueOrThrow({ where: { id }, include: STOCK_SLIP_INCLUDE });
    }, { timeout: 60000 });
    await this.log('MANUFACTURER_STOCK_CANCEL', result, userId);
    return result;
  }

  /**
   * Ghi phiếu (tạo / sửa). Dòng cũ giữ giá vốn đã chụp theo mã; mã mới: Gửi lấy
   * giá vốn kho gửi, Trả / Điều chỉnh lấy giá BQ tại NSX. Ghi lại log kho mình
   * của đúng phiếu, tính lại tồn, chặn âm kho mình và âm tồn NSX.
   */
  private async write(tx: Tx, input: {
    manufacturerId: number; manufacturerName: string; type: StockSlipType;
    dto: ManufacturerStockSlipDto; userId: number; existing?: SlipRow;
  }) {
    const { manufacturerId, type, dto, userId, existing } = input;
    const branchId = existing ? existing.branchId : dto.branchId ?? null;
    let branch: { id: number; name: string } | null = null;
    if (type !== 'ADJUST') {
      if (!branchId) throw new BadRequestException(type === 'SEND' ? 'Vui lòng chọn kho gửi' : 'Vui lòng chọn kho nhận');
      branch = await tx.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true } });
      if (!branch) throw new BadRequestException('Kho không hợp lệ');
    }
    const date = dto.date ? documentDate(dto.date, DATE_LABEL[type]) : existing?.date ?? new Date();
    const ids = dto.lines.map((line) => line.productId);
    if (!ids.length) throw new BadRequestException('Vui lòng nhập nguyên liệu');
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Nguyên liệu trong phiếu không được trùng mã');
    const products = new Map((await tx.product.findMany({ where: { id: { in: ids } } })).map((product) => [product.id, product]));
    const oldLines = new Map((existing?.lines ?? []).map((line) => [line.productId, line]));
    const allIds = [...new Set([...ids, ...oldLines.keys()])].sort((a, b) => a - b);

    if (branch) {
      for (const productId of allIds) {
        if (type === 'RETURN') await ensureInventoryRow(tx, productId, branch.id);
        await tx.$queryRaw`SELECT id FROM inventories WHERE "productId" = ${productId} AND "branchId" = ${branch.id} FOR UPDATE`;
      }
    }
    const stock = await manufacturerStock(tx, manufacturerId, allIds, { excludeSlipId: existing?.id });

    const lines: Array<{
      productId: number; productCode: string; productName: string; quantity: Prisma.Decimal; unit: string;
      conversionFactor: number; units: Prisma.Decimal; systemUnits: Prisma.Decimal | null; unitCost: Prisma.Decimal; amount: number;
    }> = [];
    for (const line of dto.lines) {
      const product = products.get(line.productId);
      if (!product || ![2, 4].includes(product.type)) throw new BadRequestException('Nguyên liệu phải là hàng hóa có quản lý tồn');
      const conversionFactor = ownConversion(product, line.unit);
      const entered = D(line.quantity).toDecimalPlaces(4);
      const enteredUnits = entered.mul(conversionFactor).toDecimalPlaces(4);
      const old = oldLines.get(product.id);
      const balance = balanceOf(stock, product.id);
      let units: Prisma.Decimal;
      let systemUnits: Prisma.Decimal | null = null;
      let unitCost: Prisma.Decimal;
      if (type === 'ADJUST') {
        // Tồn hệ thống giữ theo lúc kiểm (dòng cũ); mã mới lấy tồn hiện tại.
        systemUnits = old?.systemUnits != null ? D(old.systemUnits) : balance.units;
        units = enteredUnits.sub(systemUnits);
        unitCost = old ? D(old.unitCost) : balance.avgCost;
      } else {
        if (!enteredUnits.gt(0)) throw new BadRequestException(`Lượng quá nhỏ sau quy đổi: ${product.name}`);
        units = type === 'SEND' ? enteredUnits : enteredUnits.negated();
        if (old) unitCost = D(old.unitCost);
        else if (type === 'SEND') {
          const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: product.id, branchId: branch!.id } } });
          unitCost = D(inv?.cost);
        } else unitCost = balance.avgCost;
      }
      lines.push({
        productId: product.id, productCode: product.code, productName: product.name, quantity: entered, unit: line.unit,
        conversionFactor, units, systemUnits, unitCost, amount: money(units.mul(unitCost)),
      });
    }

    // Kiểm trước để báo rõ "cần / còn".
    for (const line of lines) {
      const product = products.get(line.productId)!;
      const sent = { quantity: line.quantity, unit: line.unit };
      if (type === 'SEND') {
        const oldUnits = D(oldLines.get(line.productId)?.units);
        if (!line.units.sub(oldUnits).gt(0)) continue;
        const inv = await tx.inventory.findUnique({ where: { productId_branchId: { productId: line.productId, branchId: branch!.id } } });
        const available = stockOf(inv?.onHand).add(oldUnits);
        if (!inv || available.lt(line.units)) {
          throw new BadRequestException(shortage(line.productName, line.units, available, product.unit, sent, `kho gửi ${branch!.name}`));
        }
      } else if (type === 'RETURN') {
        const available = balanceOf(stock, line.productId).units;
        if (available.lt(line.units.negated())) {
          throw new BadRequestException(shortage(line.productName, line.units.negated(), available, product.unit, sent, 'NSX'));
        }
      }
    }

    const totalValue = money(lines.reduce(
      (sum, line) => sum.add(type === 'ADJUST' ? line.amount : Math.abs(line.amount)), new Prisma.Decimal(0),
    ));
    const userName = await this.actorName(tx, userId);
    const header = {
      date, note: dto.note?.trim() || null, totalValue,
      branchId: branch?.id ?? null, branchName: branch?.name ?? null,
    };
    let slipId: number;
    let code: string;
    if (existing) {
      slipId = existing.id;
      code = existing.code;
      await tx.manufacturerStockSlip.update({ where: { id: slipId }, data: { ...header, updatedByName: userName } });
      await tx.manufacturerStockSlipLine.deleteMany({ where: { slipId } });
    } else {
      const created = await tx.manufacturerStockSlip.create({ data: {
        ...header, code: `${CODE_PREFIX[type]}${randomUUID().slice(0, 8).toUpperCase()}`, type, manufacturerId,
        status: STOCK_SLIP_ACTIVE, createdById: userId, createdByName: userName,
      } });
      slipId = created.id;
      code = created.code;
    }
    await tx.manufacturerStockSlipLine.createMany({ data: lines.map((line) => ({ ...line, slipId })) });

    if (branch) {
      const branchId = branch.id;
      const branchName = branch.name;
      const pairs = allIds.map((productId) => ({ productId, branchId }));
      await tx.inventoryLog.deleteMany({ where: { refType: MANUFACTURER_STOCK_REF, refId: slipId } });
      for (const line of lines) {
        const costPrice = type === 'SEND'
          ? line.unitCost
          : D((await tx.inventory.findUnique({ where: { productId_branchId: { productId: line.productId, branchId: branch.id } } }))?.cost);
        await tx.inventoryLog.create({ data: {
          productId: line.productId, productCode: line.productCode, productName: line.productName,
          branchId: branch.id, branchName: branch.name, transactionType: LOG_TYPE[type as 'SEND' | 'RETURN'],
          refType: MANUFACTURER_STOCK_REF, refId: slipId, refCode: code,
          // Tồn NSX + là kho mình −, và ngược lại.
          quantity: line.units.negated(), costPrice, partnerName: input.manufacturerName,
          transactionDate: date, ...buildInventoryLogBase({ userId, userName }),
        } });
      }
      await recalcOnHandForPairs(tx, pairs);
      // Phần làm kho mình giảm so với trước (gửi thêm / trả bớt) không được làm âm tồn.
      const shrunk = pairs.filter((pair) => {
        const before = D(oldLines.get(pair.productId)?.units).negated();
        const after = D(lines.find((line) => line.productId === pair.productId)?.units).negated();
        return after.lt(before);
      });
      await this.assertBranchStock(tx, shrunk, (name) => type === 'RETURN'
        ? `Nguyên liệu "${name}" nhận lại đã được xuất tiếp ở ${branchName}, không thể giảm lượng trả`
        : `Không đủ tồn kho "${name}" tại kho gửi ${branchName}`);
    }
    await assertManufacturerStock(tx, manufacturerId, allIds);
    return tx.manufacturerStockSlip.findUniqueOrThrow({ where: { id: slipId }, include: STOCK_SLIP_INCLUDE });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async assertBranchStock(tx: Tx, pairs: Array<{ productId: number; branchId: number }>, message: (name: string) => string) {
    for (const pair of pairs) {
      const inv = await tx.inventory.findUnique({ where: { productId_branchId: pair } });
      if (inv && Number(inv.onHand) < -EPSILON) throw new BadRequestException(message(inv.productName));
    }
  }

  private async lockSlip(tx: Tx, id: number): Promise<SlipRow> {
    await tx.$queryRaw`SELECT id FROM manufacturer_stock_slips WHERE id = ${id} FOR UPDATE`;
    const slip = await tx.manufacturerStockSlip.findUnique({ where: { id }, include: STOCK_SLIP_INCLUDE });
    if (!slip) throw new NotFoundException('Không tìm thấy phiếu nguyên liệu NSX');
    return slip;
  }

  private async lockManufacturer(tx: Tx, id: number) {
    await tx.$queryRaw`SELECT id FROM manufacturers WHERE id = ${id} FOR UPDATE`;
    const manufacturer = await tx.manufacturer.findUnique({ where: { id } });
    if (!manufacturer) throw new NotFoundException('Không tìm thấy nhà sản xuất');
    return manufacturer;
  }

  private async manufacturerOrThrow(id: number) {
    const manufacturer = await this.prisma.manufacturer.findUnique({ where: { id }, select: { id: true } });
    if (!manufacturer) throw new NotFoundException('Không tìm thấy nhà sản xuất');
  }

  private async actorName(tx: Tx, userId: number) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    return user?.name ?? user?.email ?? 'System';
  }

  private async internal(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { supplierId: true } });
    if (user?.supplierId) throw new ForbiddenException('Chỉ nhân viên nội bộ được thao tác nguyên liệu tại NSX');
  }

  private async log(actionCode: string, row: SlipRow, userId: number, changes?: Record<string, unknown>) {
    await this.audit.create({
      actionType: 'POST', actionCode, entityType: 'manufacturer_stock_slips', entityId: String(row.id),
      entityCode: row.code, message: `${actionCode}: ${row.code}`, userId,
      userName: row.updatedByName ?? row.createdByName, branchId: row.branchId ?? undefined,
      snapshot: JSON.parse(JSON.stringify(changes ? { ...row, changes } : row)) as unknown,
    });
  }
}
