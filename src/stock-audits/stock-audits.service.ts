import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockAuditDto } from './dto/create-stock-audit.dto';
import { UpdateStockAuditDto } from './dto/update-stock-audit.dto';
import { StockAuditQueryDto } from './dto/stock-audit-query.dto';
import {
  recalcStockAuditChain,
  getActiveLogKeys,
  isLogActive,
} from '../common/inventory-onhand.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

const STOCK_AUDIT_STATUS = {
  DRAFT: 1,
  COMPLETED: 2,
  CANCELLED: 3,
};

const STOCK_AUDIT_STATUS_LABEL: Record<number, string> = {
  1: 'Phiếu tạm',
  2: 'Hoàn thành',
  3: 'Đã hủy',
};

const INCLUDE_FULL = {
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
  details: {
    include: {
      product: {
        select: { id: true, code: true, name: true, unit: true },
      },
    },
  },
};

@Injectable()
export class StockAuditsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  private buildSnapshot(audit: any) {
    const details = audit.details || [];
    const totalDiff = details.reduce(
      (s: number, d: any) => s + Number(d.difference ?? 0),
      0,
    );
    return {
      code: audit.code,
      branchName: audit.branchName || audit.branch?.name || null,
      checkDate: audit.checkDate,
      status: STOCK_AUDIT_STATUS_LABEL[audit.status] || audit.status,
      note: audit.note,
      createdByName: audit.createdByName || audit.creator?.name || null,
      totalDiff,
      details: details.map((d: any) => ({
        productCode: d.productCode || d.product?.code,
        productName: d.productName || d.product?.name,
        systemQuantity: Number(d.systemQuantity ?? 0),
        actualQuantity: Number(d.actualQuantity ?? 0),
        difference: Number(d.difference ?? 0),
      })),
    };
  }

  private async auditUserName(userId?: number): Promise<string> {
    if (!userId) return 'System';
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return u?.name || u?.email || 'System';
  }

  // ─── Nguồn chân lý DUY NHẤT cho tồn tại thời điểm ─────────────────
  // Khớp tuyệt đối với "Tồn cuối" trong thẻ kho (findInventoryLogs):
  //   1. Dùng cùng bộ lọc cancelled (getActiveLogKeys + isLogActive) — bao
  //      gồm TẤT CẢ 8 refType (invoice, purchase_order, transfer, production,
  //      destruction, return_order, supplier_return, stock_audit).
  //   2. Merge các log cùng (refType|refCode|transactionType) — tránh double
  //      count khi 1 chứng từ ghi nhiều dòng log cùng key.
  //   3. Ẩn dòng gộp có tổng quantity = 0 (NGOẠI TRỪ STOCK_AUDIT — giữ làm
  //      mốc neo tuyệt đối, giống findInventoryLogs).
  // Trước đây getStockBeforeDate chỉ filter cancelled cho `stock_audit` →
  // form kiểm kho hiển thị cột "Tồn kho" sai (vd sản phẩm TD: -28 thay vì
  // -12 do 2 hóa đơn đã hủy có tổng SL 16 chưa được loại).
  private async getStockBeforeDate(
    productId: number,
    branchId: number,
    checkDate: Date,
    excludeAuditId?: number,
  ): Promise<number> {
    const logs = await this.prisma.inventoryLog.findMany({
      where: {
        productId,
        branchId,
        transactionDate: { lt: checkDate },
        ...(excludeAuditId
          ? { NOT: { refType: 'stock_audit', refId: excludeAuditId } }
          : {}),
      },
      select: {
        id: true,
        quantity: true,
        refType: true,
        refId: true,
        refCode: true,
        transactionType: true,
      },
    });

    const activeKeys = await getActiveLogKeys(this.prisma, logs);
    const active = logs.filter((l) => isLogActive(l, activeKeys));
    return this.mergeAndSumActiveLogs(active);
  }

  // ─── Tổng toàn bộ giao dịch (Σ log) của 1 sản phẩm tại 1 chi nhánh ──
  // Dùng để set lại onHand = Σ log sau khi kiểm — giữ onHand luôn khớp với
  // thẻ kho. Cùng bộ lọc + merge với getStockBeforeDate để 1 nguồn chân lý.
  private async getTotalLogSum(
    productId: number,
    branchId: number,
    excludeAuditId?: number,
  ): Promise<number> {
    const logs = await this.prisma.inventoryLog.findMany({
      where: {
        productId,
        branchId,
        ...(excludeAuditId
          ? { NOT: { refType: 'stock_audit', refId: excludeAuditId } }
          : {}),
      },
      select: {
        id: true,
        quantity: true,
        refType: true,
        refId: true,
        refCode: true,
        transactionType: true,
      },
    });
    const activeKeys = await getActiveLogKeys(this.prisma, logs);
    const active = logs.filter((l) => isLogActive(l, activeKeys));
    return this.mergeAndSumActiveLogs(active);
  }

  // Helper: gộp log cùng (refType|refCode|transactionType) → sum quantity,
  // bỏ dòng gộp có tổng = 0 (trừ STOCK_AUDIT). Cùng logic findInventoryLogs.
  private mergeAndSumActiveLogs(
    logs: Array<{
      quantity: any;
      refType?: string | null;
      refCode?: string | null;
      transactionType: string;
    }>,
  ): number {
    type Row = (typeof logs)[number];
    const mergedMap = new Map<string, Row>();
    const ungrouped: Row[] = [];

    for (const log of logs) {
      if (!log.refCode) {
        ungrouped.push(log);
        continue;
      }
      const key = `${log.refType}|${log.refCode}|${log.transactionType}`;
      const existing = mergedMap.get(key);
      if (!existing) {
        mergedMap.set(key, { ...log });
      } else {
        existing.quantity = (Number(existing.quantity) +
          Number(log.quantity)) as any;
      }
    }

    const merged = [...mergedMap.values(), ...ungrouped].filter(
      (log) =>
        !log.refCode ||
        log.transactionType === 'STOCK_AUDIT' ||
        Number(log.quantity) !== 0,
    );
    return merged.reduce((s, l) => s + Number(l.quantity), 0);
  }

  // ─── Preview tồn tại thời điểm cho nhiều sản phẩm (phục vụ UI form) ──
  // Tối ưu N+1: load TẤT CẢ log của TẤT CẢ productIds trong 1 query, tính
  // activeKeys chung 1 lần, sau đó group theo productId.
  // Trả về { productId: stockAtMoment } — khớp thẻ kho và complete.
  async previewStockAtDate(
    branchId: number,
    productIds: number[],
    checkDate: string,
  ): Promise<Record<number, number>> {
    const date = checkDate ? new Date(checkDate) : new Date();
    const unique = [...new Set(productIds)].filter((id) => !!id);
    if (unique.length === 0) return {};

    const logs = await this.prisma.inventoryLog.findMany({
      where: {
        productId: { in: unique },
        branchId,
        transactionDate: { lt: date },
      },
      select: {
        productId: true,
        id: true,
        quantity: true,
        refType: true,
        refId: true,
        refCode: true,
        transactionType: true,
      },
    });
    const activeKeys = await getActiveLogKeys(this.prisma, logs);
    const active = logs.filter((l) => isLogActive(l, activeKeys));

    // Group theo productId, áp dụng merge trong từng nhóm.
    const byProduct = new Map<number, typeof active>();
    for (const l of active) {
      const arr = byProduct.get(l.productId) ?? [];
      arr.push(l);
      byProduct.set(l.productId, arr);
    }
    const result: Record<number, number> = {};
    for (const pid of unique) {
      result[pid] = this.mergeAndSumActiveLogs(byProduct.get(pid) ?? []);
    }
    return result;
  }

  // ─── Generate code KK000001 ─────────────────────────────────────
  private async generateCode(): Promise<string> {
    const last = await this.prisma.stockAudit.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    if (!last) return 'KK000001';

    const num = parseInt(last.code.replace('KK', ''), 10) + 1;
    return `KK${String(num).padStart(6, '0')}`;
  }

  // ─── Find All ───────────────────────────────────────────────────
  /**
   * Dựng điều kiện `where` cho phiếu kiểm kho. Tách riêng để dùng chung giữa
   * findAll (danh sách) và export/export-detail, đảm bảo bộ lọc xuất file khớp
   * hoàn toàn với bộ lọc đang hiển thị.
   */
  private buildStockAuditWhere(query: StockAuditQueryDto): any {
    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { createdByName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.branchIds) {
      const ids = query.branchIds
        .split(',')
        .map((id) => +id)
        .filter(Boolean);
      if (ids.length > 0) where.branchId = { in: ids };
    } else if (query.branchId) {
      where.branchId = +query.branchId;
    }
    if (query.status) where.status = +query.status;
    if (query.creatorId) where.createdById = +query.creatorId;
    if (query.productId) {
      where.details = { some: { productId: +query.productId } };
    }

    if (query.fromDate || query.toDate) {
      where.checkDate = {};
      if (query.fromDate) where.checkDate.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.checkDate.lte = to;
      }
    }

    return where;
  }

  async findAll(query: StockAuditQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;

    const where = this.buildStockAuditWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.stockAudit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: INCLUDE_FULL,
      }),
      this.prisma.stockAudit.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu kiểm kho = 1 dòng Excel. Bộ lọc dùng chung
   * buildStockAuditWhere với danh sách.
   */
  async exportStockAudits(
    query: StockAuditQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildStockAuditWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Kiểm kho');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Số sản phẩm', key: 'totalGoods', width: 12 },
      { header: 'Tổng tồn ban đầu', key: 'totalSystem', width: 16 },
      { header: 'Tổng tồn thực tế', key: 'totalActual', width: 16 },
      { header: 'Tổng SL lệch', key: 'totalDiff', width: 14 },
      { header: 'Tổng giá trị lệch', key: 'totalDiffValue', width: 18 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Trạng thái', key: 'status', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.stockAudit.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: {
            select: {
              systemQuantity: true,
              actualQuantity: true,
              difference: true,
              differenceValue: true,
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const a of batch) {
        const totalSystem = a.details.reduce(
          (s, d) => s + Number(d.systemQuantity),
          0,
        );
        const totalActual = a.details.reduce(
          (s, d) => s + Number(d.actualQuantity),
          0,
        );
        const totalDiff = a.details.reduce(
          (s, d) => s + Number(d.difference),
          0,
        );
        const totalDiffValue = a.details.reduce(
          (s, d) => s + Number(d.differenceValue),
          0,
        );
        const row = sheet.addRow({
          code: a.code,
          branch: a.branchName || a.branch?.name || '',
          createdBy: a.createdByName || a.creator?.name || '',
          checkDate: fmtDateTime(a.checkDate),
          createdAt: fmtDateTime(a.createdAt),
          totalGoods: a.details.length,
          totalSystem,
          totalActual,
          totalDiff,
          totalDiffValue,
          note: a.note || '',
          status: STOCK_AUDIT_STATUS_LABEL[a.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm
   * thông tin phiếu. Bộ lọc dùng chung buildStockAuditWhere với export tổng
   * quan.
   */
  async exportStockAuditsDetail(
    query: StockAuditQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildStockAuditWhere(query);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết kiểm kho');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'ĐVT', key: 'unit', width: 10 },
      { header: 'Tồn ban đầu', key: 'systemQuantity', width: 14 },
      { header: 'Tồn thực tế', key: 'actualQuantity', width: 14 },
      { header: 'SL lệch', key: 'difference', width: 12 },
      { header: 'Giá vốn', key: 'costAtCheck', width: 14 },
      { header: 'Giá trị lệch', key: 'differenceValue', width: 16 },
      { header: 'Ghi chú', key: 'note', width: 30 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.stockAudit.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });

      if (batch.length === 0) break;

      for (const a of batch) {
        const base = {
          code: a.code,
          branch: a.branchName || a.branch?.name || '',
          createdBy: a.createdByName || a.creator?.name || '',
          checkDate: fmtDateTime(a.checkDate),
          status: STOCK_AUDIT_STATUS_LABEL[a.status] || '',
        };

        if (!a.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            unit: '',
            systemQuantity: 0,
            actualQuantity: 0,
            difference: 0,
            costAtCheck: 0,
            differenceValue: 0,
            note: '',
          });
          row.commit();
          continue;
        }

        for (const d of a.details) {
          const row = sheet.addRow({
            ...base,
            productCode: d.productCode || '',
            productName: d.productName || '',
            unit: d.unit || '',
            systemQuantity: Number(d.systemQuantity) || 0,
            actualQuantity: Number(d.actualQuantity) || 0,
            difference: Number(d.difference) || 0,
            costAtCheck: Number(d.costAtCheck) || 0,
            differenceValue: Number(d.differenceValue) || 0,
            note: d.note || '',
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  // ─── Find One ───────────────────────────────────────────────────
  async findOne(id: number) {
    const record = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: INCLUDE_FULL,
    });
    if (!record) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    return record;
  }

  // ─── Create (DRAFT) ────────────────────────────────────────────
  async create(dto: CreateStockAuditDto, userId: number) {
    if (!dto.items?.length) {
      throw new BadRequestException('Phiếu kiểm phải có ít nhất 1 sản phẩm');
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true, name: true },
    });
    if (!branch) throw new BadRequestException('Chi nhánh không tồn tại');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    // Validate unique products
    const productIds = dto.items.map((i) => i.productId);
    const uniqueIds = [...new Set(productIds)];
    if (uniqueIds.length !== productIds.length) {
      throw new BadRequestException('Sản phẩm bị trùng trong phiếu kiểm');
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, code: true, name: true, unit: true },
    });
    if (products.length !== uniqueIds.length) {
      throw new BadRequestException('Một số sản phẩm không tồn tại');
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    const inventories = await this.prisma.inventory.findMany({
      where: { productId: { in: uniqueIds }, branchId: dto.branchId },
    });
    const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

    const code = await this.generateCode();
    const checkDate = dto.checkDate ? new Date(dto.checkDate) : new Date();

    // Tồn tại thời điểm kiểm cho từng sản phẩm (neo ngược từ onHand hiện tại).
    const systemQtyMap = new Map<number, number>();
    for (const id of uniqueIds) {
      systemQtyMap.set(
        id,
        await this.getStockBeforeDate(id, dto.branchId, checkDate),
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const audit = await tx.stockAudit.create({
        data: {
          code,
          branchId: branch.id,
          branchName: branch.name,
          checkDate,
          note: dto.note || null,
          status: STOCK_AUDIT_STATUS.DRAFT,
          createdById: user.id,
          createdByName: user.name,
          details: {
            createMany: {
              data: dto.items.map((item) => {
                const product = productMap.get(item.productId)!;
                const inv = invMap.get(item.productId);
                const systemQty = systemQtyMap.get(item.productId) ?? 0;
                const cost = inv ? Number(inv.cost) : 0;
                const difference = item.actualQuantity - systemQty;

                return {
                  productId: item.productId,
                  productCode: product.code,
                  productName: product.name,
                  unit: product.unit || null,
                  systemQuantity: systemQty,
                  actualQuantity: item.actualQuantity,
                  difference,
                  costAtCheck: cost,
                  differenceValue: difference * cost,
                  note: item.note || null,
                };
              }),
            },
          },
        },
      });

      const full = await tx.stockAudit.findUnique({
        where: { id: audit.id },
        include: INCLUDE_FULL,
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'STOCK_AUDIT_CREATE',
        entityType: 'stock_audits',
        entityId: audit.id.toString(),
        entityCode: audit.code,
        category: getCategoryFromActionCode('STOCK_AUDIT_CREATE'),
        severity: getSeverityFromActionCode('STOCK_AUDIT_CREATE'),
        snapshot: this.buildSnapshot(full),
        message: renderAuditMessage('STOCK_AUDIT_CREATE', {
          auditCode: audit.code,
          branchName: branch.name,
          productCount: dto.items.length,
        }),
        messageTemplate: 'STOCK_AUDIT_CREATE',
        userId: user.id,
        userName: user.name,
        branchId: branch.id,
      });

      return full;
    });
  }

  // ─── Update (chỉ DRAFT) ────────────────────────────────────────
  async update(id: number, dto: UpdateStockAuditDto, userId?: number) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status !== STOCK_AUDIT_STATUS.DRAFT) {
      throw new BadRequestException(
        'Chỉ được sửa phiếu ở trạng thái Phiếu tạm',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Update note + checkDate
      const headerData: any = {};
      if (dto.note !== undefined) headerData.note = dto.note || null;
      if (dto.checkDate !== undefined) {
        headerData.checkDate = dto.checkDate
          ? new Date(dto.checkDate)
          : new Date();
      }
      if (Object.keys(headerData).length > 0) {
        await tx.stockAudit.update({ where: { id }, data: headerData });
      }

      // checkDate hiệu lực để tính tồn thời điểm (mới nếu có, không thì giữ cũ)
      const effectiveCheckDate: Date = headerData.checkDate ?? audit.checkDate;

      // Update items
      if (dto.items?.length) {
        const productIds = dto.items.map((i) => i.productId);
        const uniqueIds = [...new Set(productIds)];
        if (uniqueIds.length !== productIds.length) {
          throw new BadRequestException('Sản phẩm bị trùng');
        }

        const products = await tx.product.findMany({
          where: { id: { in: uniqueIds } },
          select: { id: true, code: true, name: true, unit: true },
        });
        const productMap = new Map(products.map((p) => [p.id, p]));

        const inventories = await tx.inventory.findMany({
          where: { productId: { in: uniqueIds }, branchId: audit.branchId },
        });
        const invMap = new Map(inventories.map((inv) => [inv.productId, inv]));

        // Tồn tại thời điểm kiểm cho từng sản phẩm.
        const systemQtyMap = new Map<number, number>();
        for (const pid of uniqueIds) {
          systemQtyMap.set(
            pid,
            await this.getStockBeforeDate(
              pid,
              audit.branchId,
              effectiveCheckDate,
            ),
          );
        }

        // Xóa details cũ, tạo mới
        await tx.stockAuditDetail.deleteMany({
          where: { stockAuditId: id },
        });

        await tx.stockAuditDetail.createMany({
          data: dto.items.map((item) => {
            const product = productMap.get(item.productId)!;
            const inv = invMap.get(item.productId);
            const systemQty = systemQtyMap.get(item.productId) ?? 0;
            const cost = inv ? Number(inv.cost) : 0;
            const difference = item.actualQuantity - systemQty;

            return {
              stockAuditId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              unit: product.unit || null,
              systemQuantity: systemQty,
              actualQuantity: item.actualQuantity,
              difference,
              costAtCheck: cost,
              differenceValue: difference * cost,
              note: item.note || null,
            };
          }),
        });
      }

      const full = await tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'STOCK_AUDIT_UPDATE',
        entityType: 'stock_audits',
        entityId: id.toString(),
        entityCode: audit.code,
        category: getCategoryFromActionCode('STOCK_AUDIT_UPDATE'),
        severity: getSeverityFromActionCode('STOCK_AUDIT_UPDATE'),
        snapshot: this.buildSnapshot(full),
        message: renderAuditMessage('STOCK_AUDIT_UPDATE', {
          auditCode: audit.code,
        }),
        messageTemplate: 'STOCK_AUDIT_UPDATE',
        userId: userId || audit.createdById || 1,
        userName: await this.auditUserName(userId || audit.createdById),
        branchId: audit.branchId,
      });

      return full;
    });
  }

  // ─── Complete (DRAFT → COMPLETED) ──────────────────────────────
  async complete(id: number, userId: number) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status !== STOCK_AUDIT_STATUS.DRAFT) {
      throw new BadRequestException(
        'Chỉ hoàn thành phiếu ở trạng thái Phiếu tạm',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const checkDate: Date = audit.checkDate ?? new Date();

      for (const detail of audit.details) {
        const inv = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: audit.branchId,
            },
          },
          include: {
            product: { select: { weight: true, weightUnit: true } },
          },
        });

        if (!inv) continue;

        // Tính lại tồn TẠI THỜI ĐIỂM kiểm theo LOG (Σ giao dịch thật trước
        // checkDate) ngay lúc Hoàn thành. difference = thực tế − tồn-log-trước.
        const systemQty = await this.getStockBeforeDate(
          detail.productId,
          audit.branchId,
          checkDate,
          audit.id,
        );
        const delta = Number(detail.actualQuantity) - systemQty;
        const cost = Number(detail.costAtCheck);

        // Cập nhật lại snapshot trên detail cho khớp với giá trị áp dụng.
        await tx.stockAuditDetail.update({
          where: { id: detail.id },
          data: {
            systemQuantity: systemQty,
            difference: delta,
            differenceValue: delta * cost,
          },
        });

        // LUÔN ghi InventoryLog (kể cả delta = 0) — dòng này là MỐC NEO tuyệt
        // đối của phiếu kiểm trên thẻ kho. recalcStockAuditChain sẽ tính lại
        // delta đúng theo timeline (kể cả khi có phiếu/đơn lùi ngày chèn vào).
        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: audit.branchId,
            branchName: audit.branchName,
            transactionType: 'STOCK_AUDIT',
            refCode: audit.code,
            refType: 'stock_audit',
            refId: audit.id,
            quantity: delta,
            costPrice: cost,
            transactionDate: checkDate,
            note: `Kiểm kho: ${detail.productName} (HT: ${systemQty} → TT: ${detail.actualQuantity})`,
            createdByName: user?.name || audit.createdByName,
          },
        });

        // RE-ANCHOR: tính lại chuỗi phiếu kiểm + onHand theo timeline mới.
        await recalcStockAuditChain(tx, detail.productId, audit.branchId);
      }

      // Cập nhật status
      await tx.stockAudit.update({
        where: { id },
        data: {
          status: STOCK_AUDIT_STATUS.COMPLETED,
          completedById: userId,
          completedByName: user?.name || null,
          completedAt: new Date(),
        },
      });

      const full = await tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'STOCK_AUDIT_COMPLETE',
        entityType: 'stock_audits',
        entityId: id.toString(),
        entityCode: audit.code,
        category: getCategoryFromActionCode('STOCK_AUDIT_COMPLETE'),
        severity: getSeverityFromActionCode('STOCK_AUDIT_COMPLETE'),
        snapshot: this.buildSnapshot(full),
        message: renderAuditMessage('STOCK_AUDIT_COMPLETE', {
          auditCode: audit.code,
          totalDiff: this.buildSnapshot(full).totalDiff,
        }),
        messageTemplate: 'STOCK_AUDIT_COMPLETE',
        userId: userId || audit.createdById || 1,
        userName: user?.name || (await this.auditUserName(userId)),
        branchId: audit.branchId,
      });

      return full;
    });
  }

  // ─── Cancel (COMPLETED → CANCELLED) ────────────────────────────
  async cancel(id: number, userId?: number) {
    const audit = await this.prisma.stockAudit.findUnique({
      where: { id },
      include: { details: true },
    });

    if (!audit) throw new NotFoundException('Phiếu kiểm kho không tồn tại');
    if (audit.status === STOCK_AUDIT_STATUS.CANCELLED) {
      throw new BadRequestException('Phiếu đã bị hủy trước đó');
    }

    return this.prisma.$transaction(async (tx) => {
      // Đổi status → CANCELLED TRƯỚC để nguồn chân lý loại toàn bộ log của
      // phiếu này (status=3) khỏi chuỗi tính tồn.
      await tx.stockAudit.update({
        where: { id },
        data: { status: STOCK_AUDIT_STATUS.CANCELLED },
      });

      // Nếu đã COMPLETED → rollback inventory về đúng thẻ kho
      if (audit.status === STOCK_AUDIT_STATUS.COMPLETED) {
        for (const detail of audit.details) {
          // delta đã áp dụng lúc Hoàn thành (đã lưu trên detail) — dùng cho log
          // đối ứng để giữ vết lịch sử.
          const delta = Number(detail.difference);

          // Ghi InventoryLog đối ứng (giữ vết; cũng bị loại khỏi tính toán do
          // phiếu đã CANCELLED).
          if (delta !== 0) {
            await tx.inventoryLog.create({
              data: {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: detail.productName,
                branchId: audit.branchId,
                branchName: audit.branchName,
                transactionType: 'STOCK_AUDIT_CANCEL',
                refCode: audit.code,
                refType: 'stock_audit',
                refId: audit.id,
                quantity: -delta,
                costPrice: Number(detail.costAtCheck),
                transactionDate: audit.checkDate ?? new Date(),
                note: `Hủy kiểm kho: ${detail.productName}`,
                createdByName: audit.createdByName,
              },
            });
          }

          // RE-ANCHOR: phiếu này đã bị loại → tính lại delta các phiếu kiểm
          // CÒN LẠI (đứng sau nó) + onHand theo timeline mới.
          await recalcStockAuditChain(tx, detail.productId, audit.branchId);
        }
      }

      const full = await tx.stockAudit.findUnique({
        where: { id },
        include: INCLUDE_FULL,
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'STOCK_AUDIT_CANCEL',
        entityType: 'stock_audits',
        entityId: id.toString(),
        entityCode: audit.code,
        category: getCategoryFromActionCode('STOCK_AUDIT_CANCEL'),
        severity: getSeverityFromActionCode('STOCK_AUDIT_CANCEL'),
        snapshot: this.buildSnapshot(full),
        message: renderAuditMessage('STOCK_AUDIT_CANCEL', {
          auditCode: audit.code,
        }),
        messageTemplate: 'STOCK_AUDIT_CANCEL',
        userId: userId || audit.createdById || 1,
        userName: await this.auditUserName(userId || audit.createdById),
        branchId: audit.branchId,
      });

      return full;
    });
  }
}
