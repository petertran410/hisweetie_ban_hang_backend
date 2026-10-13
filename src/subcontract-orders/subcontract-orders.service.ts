import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
} from '../common/inventory-log.util';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import {
  computeSubcontractTotals,
  receiptProcessingAmount,
  recomputeSubcontractOrderTotals,
  SUBCONTRACT_RECEIPT_STATUS,
  SUBCONTRACT_STATUS,
  SUBCONTRACT_STATUS_LABEL,
} from '../common/subcontract-order.util';
import { DEFAULT_COMPONENTS_WHERE } from '../products/product-formulas.util';
import { formulaComponentToStockUnits } from './subcontract-material.util';
import {
  AtFactoryQueryDto,
  CancelSubcontractOrderDto,
  CompleteSubcontractOrderDto,
  CreateReceiptDto,
  CreateSubcontractOrderDto,
  MaterialSuggestionQueryDto,
  SendMaterialsDto,
  SubcontractCostDto,
  SubcontractMaterialDto,
  SubcontractOrderQueryDto,
  UpdateSubcontractOrderDto,
} from './dto';

type Tx = Prisma.TransactionClient;

const ORDER_INCLUDE = {
  materials: { orderBy: { id: 'asc' as const } },
  receipts: { orderBy: { id: 'asc' as const } },
  costs: { orderBy: { id: 'asc' as const } },
  payments: {
    orderBy: { id: 'desc' as const },
    include: {
      account: { select: { id: true, bankName: true, accountNumber: true } },
    },
  },
  supplier: {
    select: { id: true, code: true, name: true, debt: true },
  },
  factory: { select: { id: true, code: true, name: true, currency: true } },
  product: { select: { id: true, code: true, name: true, unit: true } },
};

// Cột chỉ người có quyền view_cost_price mới được thấy.
const ORDER_COST_FIELDS = [
  'materialCost',
  'totalCost',
  'unitCost',
  'estimatedTotalCost',
  'estimatedUnitCost',
  'appliedUnitCost',
  'appliedCostSnapshot',
  'lossPercent',
];

const num = (v: any): number => (v == null ? 0 : Number(v));

/** Prisma.Decimal → number ở mọi cấp, để FE không phải tự ép kiểu. */
function decimalsToNumbers<T>(value: T): T {
  if (value == null) return value;
  if (value instanceof Prisma.Decimal) return Number(value) as any;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(decimalsToNumbers) as any;
  if (typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value as any)) {
      out[k] = decimalsToNumbers(v);
    }
    return out;
  }
  return value;
}

@Injectable()
export class SubcontractOrdersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  // ── Đọc ────────────────────────────────────────────────────────────────

  private buildWhere(
    query: SubcontractOrderQueryDto,
  ): Prisma.SubcontractOrderWhereInput {
    const where: Prisma.SubcontractOrderWhereInput = {};
    const and: Prisma.SubcontractOrderWhereInput[] = [];

    if (query.status?.length) where.status = { in: query.status };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.factoryId) where.factoryId = query.factoryId;
    if (query.productId) where.productId = query.productId;

    if (query.branchIds?.length) {
      and.push({
        OR: [
          { branchId: { in: query.branchIds } },
          { receiveBranchId: { in: query.branchIds } },
        ],
      });
    }

    if (query.fromDate || query.toDate) {
      where.orderDate = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
      };
    }

    const search = query.search?.trim();
    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { productName: { contains: search, mode: 'insensitive' } },
          { productCode: { contains: search, mode: 'insensitive' } },
          { supplier: { name: { contains: search, mode: 'insensitive' } } },
          { factory: { name: { contains: search, mode: 'insensitive' } } },
          // Thẻ kho và công nợ NCC link theo mã ĐỢT NHẬP (LGC000001-N1).
          {
            receipts: {
              some: { code: { equals: search, mode: 'insensitive' } },
            },
          },
        ],
      });
    }

    if (and.length) where.AND = and;
    return where;
  }

  async findAll(query: SubcontractOrderQueryDto, canViewCost: boolean) {
    const { pageSize = 15, currentItem = 0 } = query;
    const where = this.buildWhere(query);

    const [total, rows] = await Promise.all([
      this.prisma.subcontractOrder.count({ where }),
      this.prisma.subcontractOrder.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: ORDER_INCLUDE,
      }),
    ]);

    return {
      total,
      pageSize,
      data: rows.map((o) => this.serialize(o, canViewCost)),
    };
  }

  async findOne(id: number, canViewCost: boolean) {
    const order = await this.prisma.subcontractOrder.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Không tìm thấy lệnh gia công');
    return this.serialize(order, canViewCost);
  }

  /**
   * Gắn số tổng tính lại từ dòng con + các chỉ số dẫn xuất cho UI:
   *  - atFactoryQuantity: NVL còn nằm ở nhà máy = đã gửi − đã trả − tiêu hao
   *    ước tính theo định mức của số thành phẩm đã nhận (chỉ lệnh đang mở).
   *  - lossPercent: hao hụt thực tế so với định mức, tính theo GIÁ TRỊ nguyên
   *    liệu / 1 thành phẩm (để gộp được nhiều nguyên liệu khác đơn vị).
   */
  private serialize(order: any, canViewCost: boolean) {
    const totals = computeSubcontractTotals(order);
    const planned = num(order.plannedQuantity);
    const isOpen =
      order.status === SUBCONTRACT_STATUS.PROCESSING ||
      order.status === SUBCONTRACT_STATUS.PARTIALLY_RECEIVED;

    const materials = order.materials.map((m: any) => {
      const sent = num(m.sentQuantity);
      const returned = num(m.returnedQuantity);
      const estimatedConsumed =
        planned > 0
          ? Math.min(
              sent,
              (num(m.plannedQuantity) * totals.goodQuantity) / planned,
            )
          : 0;
      return {
        ...m,
        atFactoryQuantity: isOpen
          ? Math.max(sent - returned - estimatedConsumed, 0)
          : 0,
      };
    });

    let lossPercent: number | null = null;
    if (
      order.status === SUBCONTRACT_STATUS.COMPLETED &&
      totals.goodQuantity > 0 &&
      planned > 0
    ) {
      const plannedValue = order.materials.reduce(
        (s: number, m: any) => s + num(m.plannedQuantity) * num(m.unitCost),
        0,
      );
      if (plannedValue > 0) {
        const actualPerUnit = totals.materialCost / totals.goodQuantity;
        const plannedPerUnit = plannedValue / planned;
        lossPercent =
          Math.round((actualPerUnit / plannedPerUnit - 1) * 10000) / 100;
      }
    }

    const result: any = decimalsToNumbers({
      ...order,
      materials,
      ...totals,
      lossPercent,
      lossExceeded:
        lossPercent != null && lossPercent > num(order.lossAllowancePercent),
      remainingAmount: totals.payableAmount - totals.paidAmount,
      costPending:
        order.status === SUBCONTRACT_STATUS.COMPLETED && !order.costAppliedAt,
      statusLabel: SUBCONTRACT_STATUS_LABEL[order.status] ?? '',
    });

    if (!canViewCost) {
      for (const f of ORDER_COST_FIELDS) result[f] = null;
      result.lossExceeded = null;
      result.materials = result.materials.map((m: any) => ({
        ...m,
        unitCost: null,
      }));
    }
    return result;
  }

  /** Điền sẵn nguyên liệu từ công thức của thành phẩm (không lưu gì). */
  async getMaterialSuggestions(query: MaterialSuggestionQueryDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: query.productId },
      include: {
        comboComponents: {
          where: query.formulaId
            ? { formulaId: query.formulaId }
            : DEFAULT_COMPONENTS_WHERE,
          orderBy: { id: 'asc' },
          include: {
            componentProduct: {
              include: { inventories: { where: { branchId: query.branchId } } },
            },
          },
        },
      },
    });
    if (!product) throw new NotFoundException('Không tìm thấy thành phẩm');

    return product.comboComponents.map((comp) => {
      const p = comp.componentProduct;
      const inv = p.inventories[0];
      return {
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        unit: p.unit,
        inputMode: comp.inputMode,
        plannedQuantity: formulaComponentToStockUnits(comp, query.quantity),
        unitCost: inv ? Number(inv.cost) : 0,
        onHand: inv ? Number(inv.onHand) : 0,
      };
    });
  }

  /** Nguyên liệu đang nằm tại nhà máy — từ các lệnh đang mở (status 2/3). */
  async getMaterialsAtFactory(query: AtFactoryQueryDto, canViewCost: boolean) {
    const orders = await this.prisma.subcontractOrder.findMany({
      where: {
        status: {
          in: [
            SUBCONTRACT_STATUS.PROCESSING,
            SUBCONTRACT_STATUS.PARTIALLY_RECEIVED,
          ],
        },
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.factoryId ? { factoryId: query.factoryId } : {}),
        ...(query.productId
          ? { materials: { some: { productId: query.productId } } }
          : {}),
      },
      orderBy: { sentDate: 'asc' },
      include: ORDER_INCLUDE,
    });

    const rows: any[] = [];
    for (const raw of orders) {
      const order = this.serialize(raw, true);
      for (const m of order.materials) {
        if (query.productId && m.productId !== query.productId) continue;
        if (m.atFactoryQuantity <= 0) continue;
        rows.push({
          orderId: order.id,
          orderCode: order.code,
          sentDate: order.sentDate,
          expectedDate: order.expectedDate,
          supplier: order.supplier,
          factory: order.factory,
          productId: m.productId,
          productCode: m.productCode,
          productName: m.productName,
          unit: m.unit,
          sentQuantity: m.sentQuantity,
          quantity: m.atFactoryQuantity,
          unitCost: canViewCost ? m.unitCost : null,
          value: canViewCost ? m.atFactoryQuantity * m.unitCost : null,
        });
      }
    }

    return {
      data: rows,
      totalValue: canViewCost
        ? rows.reduce((s, r) => s + (r.value || 0), 0)
        : null,
    };
  }

  // ── Tạo / sửa ──────────────────────────────────────────────────────────

  private async generateOrderCode(tx: Tx): Promise<string> {
    const prefix = 'LGC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    const recent = await tx.subcontractOrder.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
      orderBy: { id: 'desc' },
      take: 50,
    });
    let next =
      recent
        .map((r) => r.code)
        .filter((c) => regex.test(c))
        .reduce((max, c) => Math.max(max, parseInt(c.slice(3), 10)), 0) + 1;

    for (let i = 0; i < 20; i++, next++) {
      const code = `${prefix}${String(next).padStart(6, '0')}`;
      const exists = await tx.subcontractOrder.findUnique({ where: { code } });
      if (!exists) return code;
    }
    throw new BadRequestException('Không thể tạo mã lệnh gia công');
  }

  /** Kiểm tra + dựng dòng nguyên liệu; chụp giá vốn hiện tại ở kho xuất. */
  private async buildMaterialRows(
    tx: Tx,
    materials: SubcontractMaterialDto[],
    branchId: number,
    finishedProductId: number,
  ) {
    const ids = materials.map((m) => m.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Nguyên liệu bị trùng trong lệnh');
    }
    if (ids.includes(finishedProductId)) {
      throw new BadRequestException(
        'Nguyên liệu không được trùng với thành phẩm',
      );
    }

    const products = await tx.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        name: true,
        unit: true,
        inventories: { where: { branchId }, select: { cost: true } },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return materials.map((m) => {
      const p = byId.get(m.productId);
      if (!p) {
        throw new BadRequestException(
          `Không tìm thấy nguyên liệu id=${m.productId}`,
        );
      }
      return {
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        unit: p.unit,
        plannedQuantity: m.plannedQuantity,
        unitCost: p.inventories[0] ? p.inventories[0].cost : 0,
        note: m.note,
      };
    });
  }

  private buildCostRows(costs: SubcontractCostDto[]) {
    return costs.map((c) => ({
      type: c.type || 'other',
      name: c.name.trim(),
      amount: c.amount,
      isFactoryPayable: c.isFactoryPayable ?? false,
      costDate: c.costDate ? new Date(c.costDate) : new Date(),
      note: c.note,
    }));
  }

  private async loadHeaderRefs(
    tx: Tx,
    input: {
      supplierId: number;
      factoryId?: number | null;
      branchId: number;
      receiveBranchId: number;
      productId: number;
      formulaId?: number | null;
    },
  ) {
    const [supplier, factory, branch, receiveBranch, product, formula] =
      await Promise.all([
        tx.supplier.findUnique({ where: { id: input.supplierId } }),
        input.factoryId
          ? tx.factory.findUnique({ where: { id: input.factoryId } })
          : null,
        tx.branch.findUnique({ where: { id: input.branchId } }),
        tx.branch.findUnique({ where: { id: input.receiveBranchId } }),
        tx.product.findUnique({ where: { id: input.productId } }),
        input.formulaId
          ? tx.productFormula.findUnique({ where: { id: input.formulaId } })
          : null,
      ]);

    if (!supplier) throw new BadRequestException('Không tìm thấy nhà cung cấp');
    if (input.factoryId && !factory) {
      throw new BadRequestException('Không tìm thấy nhà máy');
    }
    if (factory?.supplierId && factory.supplierId !== supplier.id) {
      throw new BadRequestException('Nhà máy không thuộc nhà cung cấp đã chọn');
    }
    if (!branch) throw new BadRequestException('Không tìm thấy kho xuất');
    if (!receiveBranch)
      throw new BadRequestException('Không tìm thấy kho nhận');
    if (!product) throw new BadRequestException('Không tìm thấy thành phẩm');
    if (input.formulaId && (!formula || formula.productId !== product.id)) {
      throw new BadRequestException('Công thức không thuộc thành phẩm này');
    }
    return { supplier, factory, branch, receiveBranch, product, formula };
  }

  async create(dto: CreateSubcontractOrderDto, userId: number) {
    const currency = dto.currency || 'VND';
    const exchangeRate = currency === 'VND' ? 1 : num(dto.exchangeRate);
    if (currency !== 'VND' && exchangeRate <= 0) {
      throw new BadRequestException('Vui lòng nhập tỷ giá cho lệnh ngoại tệ');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const refs = await this.loadHeaderRefs(tx, dto);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const materialRows = await this.buildMaterialRows(
        tx,
        dto.materials ?? [],
        dto.branchId,
        dto.productId,
      );
      const code = await this.generateOrderCode(tx);

      return tx.subcontractOrder.create({
        data: {
          code,
          supplierId: refs.supplier.id,
          factoryId: refs.factory?.id ?? null,
          branchId: refs.branch.id,
          branchName: refs.branch.name,
          receiveBranchId: refs.receiveBranch.id,
          receiveBranchName: refs.receiveBranch.name,
          productId: refs.product.id,
          productCode: refs.product.code,
          productName: refs.product.name,
          formulaId: refs.formula?.id ?? null,
          formulaName: refs.formula?.name ?? null,
          plannedQuantity: dto.plannedQuantity,
          processingUnitPrice: dto.processingUnitPrice,
          currency,
          exchangeRate,
          lossAllowancePercent: dto.lossAllowancePercent ?? 0,
          status: SUBCONTRACT_STATUS.DRAFT,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          note: dto.note,
          createdById: userId,
          createdByName: user?.name || '',
          materials: { create: materialRows },
          costs: { create: this.buildCostRows(dto.costs ?? []) },
        },
      });
    });

    await this.audit('SUBCONTRACT_ORDER_CREATE', 'POST', order, userId);
    return this.findOne(order.id, true);
  }

  /**
   * Nháp: sửa được mọi thứ (nguyên liệu/chi phí gửi lên sẽ THAY THẾ toàn bộ).
   * Đã gửi nguyên liệu (2/3): chỉ sửa điều khoản chưa phát sinh — đơn giá gia
   * công + tỷ giá (áp cho các đợt nhập SAU), % hao hụt, ngày dự kiến, ghi chú.
   */
  async update(id: number, dto: UpdateSubcontractOrderDto, userId: number) {
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');

      if (
        current.status === SUBCONTRACT_STATUS.COMPLETED ||
        current.status === SUBCONTRACT_STATUS.CANCELLED
      ) {
        throw new BadRequestException(
          'Lệnh đã hoàn thành hoặc đã hủy, không thể sửa',
        );
      }

      const expectedDate =
        dto.expectedDate === undefined
          ? undefined
          : dto.expectedDate
            ? new Date(dto.expectedDate)
            : null;

      if (current.status !== SUBCONTRACT_STATUS.DRAFT) {
        const exchangeRate =
          dto.exchangeRate !== undefined && current.currency !== 'VND'
            ? dto.exchangeRate
            : undefined;
        if (exchangeRate !== undefined && exchangeRate <= 0) {
          throw new BadRequestException('Tỷ giá phải lớn hơn 0');
        }
        return tx.subcontractOrder.update({
          where: { id },
          data: {
            processingUnitPrice: dto.processingUnitPrice,
            exchangeRate,
            lossAllowancePercent: dto.lossAllowancePercent,
            expectedDate,
            note: dto.note,
          },
        });
      }

      const merged = {
        supplierId: dto.supplierId ?? current.supplierId,
        factoryId:
          dto.factoryId === undefined ? current.factoryId : dto.factoryId,
        branchId: dto.branchId ?? current.branchId,
        receiveBranchId: dto.receiveBranchId ?? current.receiveBranchId,
        productId: dto.productId ?? current.productId,
        formulaId:
          dto.formulaId === undefined ? current.formulaId : dto.formulaId,
      };
      const refs = await this.loadHeaderRefs(tx, merged);

      const currency = dto.currency ?? current.currency;
      const exchangeRate =
        currency === 'VND' ? 1 : num(dto.exchangeRate ?? current.exchangeRate);
      if (exchangeRate <= 0) {
        throw new BadRequestException('Vui lòng nhập tỷ giá cho lệnh ngoại tệ');
      }

      if (dto.materials) {
        const rows = await this.buildMaterialRows(
          tx,
          dto.materials,
          merged.branchId,
          merged.productId,
        );
        await tx.subcontractOrderMaterial.deleteMany({
          where: { orderId: id },
        });
        await tx.subcontractOrderMaterial.createMany({
          data: rows.map((r) => ({ ...r, orderId: id })),
        });
      }
      if (dto.costs) {
        await tx.subcontractOrderCost.deleteMany({ where: { orderId: id } });
        await tx.subcontractOrderCost.createMany({
          data: this.buildCostRows(dto.costs).map((r) => ({
            ...r,
            orderId: id,
          })),
        });
      }

      return tx.subcontractOrder.update({
        where: { id },
        data: {
          supplierId: refs.supplier.id,
          factoryId: refs.factory?.id ?? null,
          branchId: refs.branch.id,
          branchName: refs.branch.name,
          receiveBranchId: refs.receiveBranch.id,
          receiveBranchName: refs.receiveBranch.name,
          productId: refs.product.id,
          productCode: refs.product.code,
          productName: refs.product.name,
          formulaId: refs.formula?.id ?? null,
          formulaName: refs.formula?.name ?? null,
          plannedQuantity: dto.plannedQuantity,
          processingUnitPrice: dto.processingUnitPrice,
          currency,
          exchangeRate,
          lossAllowancePercent: dto.lossAllowancePercent,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
          expectedDate,
          note: dto.note,
        },
      });
    });

    await this.audit('SUBCONTRACT_ORDER_UPDATE', 'PUT', order, userId);
    return this.findOne(id, true);
  }

  // ── Gửi nguyên liệu (1 → 2) ────────────────────────────────────────────

  async sendMaterials(id: number, dto: SendMaterialsDto, userId: number) {
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({
        where: { id },
        include: { materials: true, supplier: { select: { name: true } } },
      });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
      if (current.status !== SUBCONTRACT_STATUS.DRAFT) {
        throw new BadRequestException('Chỉ gửi nguyên liệu được từ lệnh nháp');
      }
      if (num(current.plannedQuantity) <= 0) {
        throw new BadRequestException('Số lượng kế hoạch phải lớn hơn 0');
      }

      const sentById = new Map(
        (dto.materials ?? []).map((m) => [m.id, m.sentQuantity]),
      );
      const lines = current.materials
        .map((m) => ({
          material: m,
          sent: sentById.has(m.id)
            ? Number(sentById.get(m.id))
            : num(m.plannedQuantity),
        }))
        .filter((l) => l.sent > 0);
      if (lines.length === 0) {
        throw new BadRequestException(
          'Lệnh chưa có nguyên liệu nào để gửi đi gia công',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const actor = buildInventoryLogActor(userId, user?.name);
      const sentDate = dto.sentDate ? new Date(dto.sentDate) : new Date();

      for (const { material, sent } of lines) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: material.productId,
              branchId: current.branchId,
            },
          },
        });
        if (!inventory) {
          throw new BadRequestException(
            `Nguyên liệu ${material.productName} chưa có tồn kho tại ${current.branchName}`,
          );
        }

        // Chụp giá vốn lúc xuất — đây là giá dùng để tính giá thành.
        await tx.subcontractOrderMaterial.update({
          where: { id: material.id },
          data: { sentQuantity: sent, unitCost: inventory.cost },
        });

        await tx.inventoryLog.create({
          data: {
            productId: material.productId,
            productCode: material.productCode,
            productName: material.productName,
            branchId: current.branchId,
            branchName: current.branchName,
            transactionType: 'SUBCONTRACT_OUT',
            refCode: current.code,
            refType: 'subcontract_order',
            refId: current.id,
            quantity: -sent,
            costPrice: inventory.cost,
            transactionPrice: inventory.cost,
            partnerId: current.supplierId,
            partnerName: current.supplier?.name,
            note: `Xuất nguyên liệu gia công ${current.code}`,
            transactionDate: sentDate,
            ...buildInventoryLogBase(actor),
          },
        });
      }

      // Nguyên liệu không gửi (SL = 0) → ghi rõ 0 để không còn mang SL cũ.
      const sentIds = new Set(lines.map((l) => l.material.id));
      await tx.subcontractOrderMaterial.updateMany({
        where: { orderId: id, id: { notIn: Array.from(sentIds) } },
        data: { sentQuantity: 0 },
      });

      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: { status: SUBCONTRACT_STATUS.PROCESSING, sentDate },
      });

      const pairs = lines.map((l) => ({
        productId: l.material.productId,
        branchId: current.branchId,
      }));
      await recalcOnHandForPairs(tx, pairs);
      await this.assertNotNegative(
        tx,
        pairs,
        'Không đủ tồn kho nguyên liệu để gửi',
      );

      await recomputeSubcontractOrderTotals(tx, id);
      // Chi phí "trả cho nhà máy" bắt đầu tính vào công nợ từ lúc gửi.
      await recalcSupplierDebt(tx, current.supplierId);
      return updated;
    });

    await this.audit('SUBCONTRACT_ORDER_SEND', 'POST', order, userId);
    return this.findOne(id, true);
  }

  // ── Nhập thành phẩm (2/3 → 3) ──────────────────────────────────────────

  async createReceipt(id: number, dto: CreateReceiptDto, userId: number) {
    const good = num(dto.goodQuantity);
    const defect = num(dto.defectQuantity);
    if (good + defect <= 0) {
      throw new BadRequestException('Vui lòng nhập số lượng thành phẩm');
    }

    const { order, receipt } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({
        where: { id },
        include: {
          supplier: { select: { name: true } },
          product: true,
          _count: { select: { receipts: true } },
        },
      });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
      if (
        current.status !== SUBCONTRACT_STATUS.PROCESSING &&
        current.status !== SUBCONTRACT_STATUS.PARTIALLY_RECEIVED
      ) {
        throw new BadRequestException(
          'Chỉ nhập thành phẩm cho lệnh đang gia công',
        );
      }

      const receivedDate = dto.receivedDate
        ? new Date(dto.receivedDate)
        : new Date();
      // So theo NGÀY: form chỉ chọn ngày nên giờ-phút không đáng tin để chặn.
      if (
        current.sentDate &&
        receivedDate.toISOString().slice(0, 10) <
          current.sentDate.toISOString().slice(0, 10)
      ) {
        throw new BadRequestException(
          'Ngày nhận không được trước ngày gửi nguyên liệu',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const unitPrice = num(current.processingUnitPrice);
      const exchangeRate = num(current.exchangeRate) || 1;
      const amount = receiptProcessingAmount(good, unitPrice, exchangeRate);

      // Mỗi đợt một mã riêng: thẻ kho gộp dòng theo refType|refCode nên các
      // đợt dùng chung mã lệnh sẽ bị dồn thành một dòng.
      const created = await tx.subcontractOrderReceipt.create({
        data: {
          code: `${current.code}-N${current._count.receipts + 1}`,
          orderId: id,
          receivedDate,
          goodQuantity: good,
          defectQuantity: defect,
          unitPrice,
          exchangeRate,
          foreignAmount:
            current.currency === 'VND'
              ? null
              : Math.round(good * unitPrice * 100) / 100,
          amount,
          status: SUBCONTRACT_RECEIPT_STATUS.ACTIVE,
          note: dto.note,
          createdById: userId,
          createdByName: user?.name || '',
        },
      });

      if (good > 0) {
        const inventory = await this.ensureInventory(
          tx,
          current.product,
          current.receiveBranchId,
          current.receiveBranchName,
        );
        await tx.inventoryLog.create({
          data: {
            productId: current.productId,
            productCode: current.productCode,
            productName: current.productName,
            branchId: current.receiveBranchId,
            branchName: current.receiveBranchName,
            transactionType: 'SUBCONTRACT_IN',
            refCode: created.code,
            refType: 'subcontract_receipt',
            refId: created.id,
            quantity: good,
            costPrice: inventory.cost,
            transactionPrice: unitPrice * exchangeRate,
            partnerId: current.supplierId,
            partnerName: current.supplier?.name,
            note: `Nhập thành phẩm gia công ${current.code}`,
            transactionDate: receivedDate,
            ...buildInventoryLogBase(
              buildInventoryLogActor(userId, user?.name),
            ),
          },
        });
        await recalcOnHandForPairs(tx, [
          { productId: current.productId, branchId: current.receiveBranchId },
        ]);
      }

      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: { status: SUBCONTRACT_STATUS.PARTIALLY_RECEIVED },
      });
      await recomputeSubcontractOrderTotals(tx, id);
      await recalcSupplierDebt(tx, current.supplierId);
      return { order: updated, receipt: created };
    });

    await this.audit('SUBCONTRACT_ORDER_RECEIVE', 'POST', order, userId, {
      receiptCode: receipt.code,
      goodQuantity: good,
    });
    return this.findOne(id, true);
  }

  async cancelReceipt(id: number, receiptId: number, userId: number) {
    const { order, receipt } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
      const target = await tx.subcontractOrderReceipt.findFirst({
        where: { id: receiptId, orderId: id },
      });
      if (!target) throw new NotFoundException('Không tìm thấy đợt nhập');
      if (target.status === SUBCONTRACT_RECEIPT_STATUS.CANCELLED) {
        throw new BadRequestException('Đợt nhập này đã hủy');
      }
      if (current.status !== SUBCONTRACT_STATUS.PARTIALLY_RECEIVED) {
        throw new BadRequestException(
          'Chỉ hủy được đợt nhập khi lệnh chưa hoàn thành',
        );
      }

      await tx.subcontractOrderReceipt.update({
        where: { id: receiptId },
        data: {
          status: SUBCONTRACT_RECEIPT_STATUS.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      const remaining = await tx.subcontractOrderReceipt.count({
        where: { orderId: id, status: SUBCONTRACT_RECEIPT_STATUS.ACTIVE },
      });
      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: {
          status:
            remaining > 0
              ? SUBCONTRACT_STATUS.PARTIALLY_RECEIVED
              : SUBCONTRACT_STATUS.PROCESSING,
        },
      });

      const pairs = [
        { productId: current.productId, branchId: current.receiveBranchId },
      ];
      await recalcOnHandForPairs(tx, pairs);
      await this.assertNotNegative(
        tx,
        pairs,
        'Thành phẩm của đợt này đã được bán/xuất, không thể hủy đợt nhập',
      );

      await recomputeSubcontractOrderTotals(tx, id);
      await recalcSupplierDebt(tx, current.supplierId);
      return { order: updated, receipt: target };
    });

    await this.audit(
      'SUBCONTRACT_ORDER_RECEIPT_CANCEL',
      'POST',
      order,
      userId,
      { receiptCode: receipt.code },
    );
    return this.findOne(id, true);
  }

  // ── Chi phí khác ───────────────────────────────────────────────────────

  /** Chi phí sửa được tới khi giá vốn đã áp — sau đó giá thành phải đứng yên. */
  private async loadOrderForCostEdit(tx: Tx, id: number) {
    const current = await tx.subcontractOrder.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
    if (current.status === SUBCONTRACT_STATUS.CANCELLED) {
      throw new BadRequestException('Lệnh đã hủy, không thể sửa chi phí');
    }
    if (current.costAppliedAt) {
      throw new BadRequestException(
        'Lệnh đã áp giá vốn, không thể sửa chi phí',
      );
    }
    return current;
  }

  private async afterCostChange(
    tx: Tx,
    order: { id: number; supplierId: number },
  ) {
    await recomputeSubcontractOrderTotals(tx, order.id);
    await recalcSupplierDebt(tx, order.supplierId);
  }

  async addCost(id: number, dto: SubcontractCostDto) {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.loadOrderForCostEdit(tx, id);
      await tx.subcontractOrderCost.create({
        data: { ...this.buildCostRows([dto])[0], orderId: id },
      });
      await this.afterCostChange(tx, current);
    });
    return this.findOne(id, true);
  }

  async updateCost(id: number, costId: number, dto: SubcontractCostDto) {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.loadOrderForCostEdit(tx, id);
      const cost = await tx.subcontractOrderCost.findFirst({
        where: { id: costId, orderId: id },
      });
      if (!cost) throw new NotFoundException('Không tìm thấy dòng chi phí');
      const row = this.buildCostRows([dto])[0];
      await tx.subcontractOrderCost.update({
        where: { id: costId },
        data: {
          ...row,
          // Không gửi ngày → giữ ngày cũ (buildCostRows mặc định là hôm nay).
          costDate: dto.costDate ? row.costDate : cost.costDate,
        },
      });
      await this.afterCostChange(tx, current);
    });
    return this.findOne(id, true);
  }

  async removeCost(id: number, costId: number) {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.loadOrderForCostEdit(tx, id);
      const { count } = await tx.subcontractOrderCost.deleteMany({
        where: { id: costId, orderId: id },
      });
      if (count === 0)
        throw new NotFoundException('Không tìm thấy dòng chi phí');
      await this.afterCostChange(tx, current);
    });
    return this.findOne(id, true);
  }

  // ── Hoàn thành & quyết toán (2/3 → 4) ──────────────────────────────────

  async complete(id: number, dto: CompleteSubcontractOrderDto, userId: number) {
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({
        where: { id },
        include: {
          materials: true,
          receipts: true,
          supplier: { select: { name: true } },
        },
      });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
      if (
        current.status !== SUBCONTRACT_STATUS.PROCESSING &&
        current.status !== SUBCONTRACT_STATUS.PARTIALLY_RECEIVED
      ) {
        throw new BadRequestException('Chỉ hoàn thành được lệnh đang gia công');
      }
      const goodQuantity = current.receipts
        .filter((r) => r.status === SUBCONTRACT_RECEIPT_STATUS.ACTIVE)
        .reduce((s, r) => s + num(r.goodQuantity), 0);
      if (goodQuantity <= 0) {
        throw new BadRequestException(
          'Lệnh chưa nhập thành phẩm đạt nào, không thể hoàn thành',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const actor = buildInventoryLogActor(userId, user?.name);
      const completedDate = dto.completedDate
        ? new Date(dto.completedDate)
        : new Date();
      const returnedById = new Map(
        (dto.materials ?? []).map((m) => [m.id, m.returnedQuantity]),
      );

      const pairs: { productId: number; branchId: number }[] = [];
      for (const material of current.materials) {
        const sent = num(material.sentQuantity);
        const returned = Number(returnedById.get(material.id) ?? 0);
        if (returned > sent) {
          throw new BadRequestException(
            `Số lượng trả về của ${material.productName} vượt số đã gửi`,
          );
        }

        await tx.subcontractOrderMaterial.update({
          where: { id: material.id },
          data: {
            returnedQuantity: returned,
            consumedQuantity: sent - returned,
          },
        });

        if (returned > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: material.productId,
              productCode: material.productCode,
              productName: material.productName,
              branchId: current.branchId,
              branchName: current.branchName,
              transactionType: 'SUBCONTRACT_RETURN_IN',
              refCode: current.code,
              refType: 'subcontract_order',
              refId: current.id,
              quantity: returned,
              costPrice: material.unitCost,
              transactionPrice: material.unitCost,
              partnerId: current.supplierId,
              partnerName: current.supplier?.name,
              note: `Nhận lại nguyên liệu thừa ${current.code}`,
              transactionDate: completedDate,
              ...buildInventoryLogBase(actor),
            },
          });
          pairs.push({
            productId: material.productId,
            branchId: current.branchId,
          });
        }
      }

      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: { status: SUBCONTRACT_STATUS.COMPLETED, completedDate },
      });
      await recalcOnHandForPairs(tx, pairs);
      await recomputeSubcontractOrderTotals(tx, id);
      return updated;
    });

    await this.audit('SUBCONTRACT_ORDER_COMPLETE', 'POST', order, userId);
    return this.findOne(id, true);
  }

  // ── Hủy lệnh (→ 5) ─────────────────────────────────────────────────────

  async cancel(id: number, dto: CancelSubcontractOrderDto, userId: number) {
    const order = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subcontractOrder.findUnique({
        where: { id },
        include: { materials: true, payments: true },
      });
      if (!current) throw new NotFoundException('Không tìm thấy lệnh gia công');
      if (current.status === SUBCONTRACT_STATUS.CANCELLED) {
        throw new BadRequestException('Lệnh đã hủy');
      }
      if (current.costAppliedAt) {
        throw new BadRequestException(
          'Lệnh đã áp giá vốn cho thành phẩm, không thể hủy',
        );
      }

      const activePayments = current.payments.filter((p) => p.status !== 2);
      if (activePayments.length > 0) {
        if (!dto.cancelPayments) {
          throw new BadRequestException(
            'Lệnh đã có thanh toán. Cần hủy các phiếu chi trước hoặc chọn hủy kèm thanh toán',
          );
        }
        const cashFlowIds = activePayments
          .map((p) => p.cashFlowId)
          .filter((v): v is number => v != null);
        await tx.cashFlow.updateMany({
          where: {
            OR: [
              { id: { in: cashFlowIds } },
              { code: { in: activePayments.map((p) => p.code) } },
            ],
            partnerType: 'S',
            partnerId: current.supplierId,
            status: { not: 2 },
          },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
        await tx.subcontractOrderPayment.updateMany({
          where: { id: { in: activePayments.map((p) => p.id) } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });
      }

      const wasActive = current.status !== SUBCONTRACT_STATUS.DRAFT;
      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: {
          status: SUBCONTRACT_STATUS.CANCELLED,
          cancelReason: dto.reason,
          cancelledAt: new Date(),
        },
      });

      if (wasActive) {
        // Đổi trạng thái là đủ để ACTIVE_FINDERS void mọi log của lệnh và của
        // các đợt nhập; chỉ cần dẫn xuất lại tồn.
        const finishedPair = {
          productId: current.productId,
          branchId: current.receiveBranchId,
        };
        await recalcOnHandForPairs(tx, [
          ...current.materials.map((m) => ({
            productId: m.productId,
            branchId: current.branchId,
          })),
          finishedPair,
        ]);
        await this.assertNotNegative(
          tx,
          [finishedPair],
          'Thành phẩm của lệnh đã được bán/xuất, không thể hủy lệnh',
        );
      }

      await recomputeSubcontractOrderTotals(tx, id);
      await recalcSupplierDebt(tx, current.supplierId);
      return updated;
    });

    await this.audit('SUBCONTRACT_ORDER_CANCEL', 'POST', order, userId);
    return this.findOne(id, true);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** recalcOnHandForPairs bỏ qua cặp chưa có dòng Inventory → tạo trước. */
  private async ensureInventory(
    tx: Tx,
    product: { id: number; code: string; name: string },
    branchId: number,
    branchName: string,
  ) {
    const where = { productId_branchId: { productId: product.id, branchId } };
    const existing = await tx.inventory.findUnique({ where });
    if (existing) return existing;
    return tx.inventory.create({
      data: {
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        branchId,
        branchName,
        cost: 0,
        onHand: 0,
        totalWeight: 0,
        reserved: 0,
        onOrder: 0,
        minQuality: 0,
        maxQuality: 0,
      },
    });
  }

  /**
   * Kiểm tra SAU khi recalc (đã tính cả mốc phiếu kiểm kho) rồi mới throw —
   * transaction rollback nên không để lại log/trạng thái dở dang.
   */
  private async assertNotNegative(
    tx: Tx,
    pairs: { productId: number; branchId: number }[],
    message: string,
  ) {
    for (const pair of pairs) {
      const inv = await tx.inventory.findUnique({
        where: { productId_branchId: pair },
        select: { onHand: true, productName: true },
      });
      if (inv && Number(inv.onHand) < 0) {
        throw new BadRequestException(`${message}: ${inv.productName}`);
      }
    }
  }

  private async audit(
    actionCode: string,
    actionType: string,
    order: { id: number; code: string; branchId: number; productName: string },
    userId: number,
    params: Record<string, any> = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    await this.auditLogsService.create({
      actionType,
      actionCode,
      entityType: 'subcontract_order',
      entityId: order.id.toString(),
      entityCode: order.code,
      category: getCategoryFromActionCode(actionCode),
      severity: getSeverityFromActionCode(actionCode),
      snapshot: { code: order.code, productName: order.productName, ...params },
      message: renderAuditMessage(actionCode, {
        orderCode: order.code,
        ...params,
      }),
      messageTemplate: actionCode,
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: order.branchId,
    });
  }
}
