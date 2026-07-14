import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  CreateSupplierReturnDto,
  ConfirmExportDto,
  ConfirmRefundDto,
  SupplierReturnQueryDto,
  SUPPLIER_RETURN_STATUS,
  UpdateStep1Dto,
  ImportSupplierReturnsDto,
  SUPPLIER_RETURN_STATUS_LABELS,
} from './dto';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

@Injectable()
export class SupplierReturnsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async generateCode(tx: any): Promise<string> {
    const last = await tx.supplierReturn.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = last ? last.id + 1 : 1;
    return `THN${nextId.toString().padStart(6, '0')}`;
  }

  private async generateCashFlowCode(
    isReceipt: boolean,
    tx: any,
  ): Promise<string> {
    const prefix = isReceipt ? 'TT' : 'PC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);

    const allCF = await tx.cashFlow.findMany({
      where: { code: { startsWith: prefix }, isReceipt },
      select: { code: true },
    });

    const numbers = allCF
      .map((cf: any) => cf.code)
      .filter((code: string) => regex.test(code))
      .map((code: string) => parseInt(code.replace(prefix, ''), 10));

    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    return `${prefix}${String(maxNumber + 1).padStart(6, '0')}`;
  }

  /**
   * Tái tính Supplier.debt — delegate sang recalcSupplierDebt (Formula B).
   * Giữ wrapper để không phải sửa các call-site cũ.
   */
  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private normalizeCurrency(currency?: string | null, exchangeRate?: unknown) {
    const normalizedCurrency = (currency || 'VND').toUpperCase();
    if (!['VND', 'CNY'].includes(normalizedCurrency)) {
      throw new BadRequestException('Chỉ hỗ trợ tiền tệ VND hoặc CNY');
    }
    const normalizedRate = normalizedCurrency === 'VND' ? 1 : Number(exchangeRate);
    if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
      throw new BadRequestException('Tỷ giá ngoại tệ phải lớn hơn 0');
    }
    return { currency: normalizedCurrency, exchangeRate: normalizedRate };
  }

  private normalizeDetailAmounts(detail: any, currency: string, exchangeRate: number) {
    const quantity = Number(detail.requestQuantity);
    const inputMode = detail.inputMode || 'unit_price';
    if (currency === 'VND') {
      const totalAmount = this.roundMoney(Number(detail.totalAmount));
      return {
        inputMode,
        returnPrice: quantity > 0 ? this.roundMoney(totalAmount / quantity) : 0,
        totalAmount,
        foreignReturnPrice: null,
        foreignReturnAmount: null,
      };
    }

    let foreignReturnAmount: number;
    let foreignReturnPrice: number;
    if (inputMode === 'total_amount') {
      foreignReturnAmount = this.roundMoney(Number(detail.foreignReturnAmount));
      foreignReturnPrice = quantity > 0
        ? this.roundMoney(foreignReturnAmount / quantity)
        : 0;
    } else {
      foreignReturnPrice = this.roundMoney(Number(detail.foreignReturnPrice));
      foreignReturnAmount = this.roundMoney(foreignReturnPrice * quantity);
    }
    if (!Number.isFinite(foreignReturnAmount) || !Number.isFinite(foreignReturnPrice)) {
      throw new BadRequestException(
        `Sản phẩm ${detail.productName}: Thiếu số tiền ngoại tệ hợp lệ`,
      );
    }
    const totalAmount = this.roundMoney(foreignReturnAmount * exchangeRate);
    return {
      inputMode,
      foreignReturnPrice,
      foreignReturnAmount,
      totalAmount,
      returnPrice: quantity > 0 ? this.roundMoney(totalAmount / quantity) : 0,
    };
  }

  // ─── findAll ─────────────────────────────────────────────────────────────────

  /**
   * Dựng điều kiện `where` cho phiếu trả hàng nhập. Tách riêng để dùng chung
   * giữa findAll (danh sách) và export/export-detail, đảm bảo bộ lọc xuất file
   * khớp hoàn toàn với bộ lọc đang hiển thị (bao gồm cả scope NCC).
   */
  private buildSupplierReturnWhere(
    query: SupplierReturnQueryDto,
    supplierScope?: number | null,
  ): any {
    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        {
          supplier: { name: { contains: query.search, mode: 'insensitive' } },
        },
      ];
    }

    if (query.supplierIds && query.supplierIds.length > 0) {
      where.supplierId = { in: query.supplierIds };
    } else if (query.supplierId) {
      where.supplierId = query.supplierId;
    }
    if (query.branchIds && query.branchIds.length > 0) {
      where.branchId = { in: query.branchIds };
    } else if (query.branchId) {
      where.branchId = query.branchId;
    }
    if (query.status) where.status = query.status;
    if (query.mode) where.mode = query.mode;
    if (query.refundType) {
      where.refundType = query.refundType;
    } else {
      // Mặc định ẩn CTNCC (manual_offset — cấn trừ tiền trả thừa NCC) khỏi
      // danh sách phiếu trả hàng nhập. Đối xứng trang trả hàng KH ẩn CTN.
      // Dùng AND + OR-null vì SQL `<> 'manual_offset'` loại luôn hàng NULL,
      // và để KHÔNG đụng `where.OR` của bộ lọc search ở trên.
      where.AND = [
        ...(where.AND || []),
        {
          OR: [{ refundType: null }, { refundType: { not: 'manual_offset' } }],
        },
      ];
    }
    if (query.createdBy) where.createdBy = query.createdBy;

    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
      if (query.toDate) where.createdAt.lte = new Date(query.toDate);
    }

    // Scope NCC: ép theo nhà cung cấp của user (ghi đè mọi supplierId từ query).
    if (supplierScope != null) where.supplierId = supplierScope;

    return where;
  }

  async findAll(query: SupplierReturnQueryDto, supplierScope?: number | null) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = this.buildSupplierReturnWhere(query, supplierScope);

    const [data, total] = await Promise.all([
      this.prisma.supplierReturn.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, code: true, currency: true, exchangeRate: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.supplierReturn.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu trả hàng nhập = 1 dòng Excel. Bộ lọc dùng
   * chung buildSupplierReturnWhere với danh sách.
   */
  async exportSupplierReturns(
    query: SupplierReturnQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildSupplierReturnWhere(query, supplierScope);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Trả hàng nhập');

    sheet.columns = [
      { header: 'Mã trả hàng nhập', key: 'code', width: 18 },
      { header: 'Mã phiếu nhập', key: 'purchaseOrderCode', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Mã NCC', key: 'supplierCode', width: 14 },
      { header: 'Tên nhà cung cấp', key: 'supplierName', width: 24 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Số mặt hàng', key: 'totalGoods', width: 12 },
      { header: 'Tổng SL trả', key: 'totalQuantity', width: 14 },
      { header: 'Tổng tiền trả', key: 'totalReturnAmount', width: 16 },
      { header: 'Tiền cần hoàn', key: 'refundAmount', width: 16 },
      { header: 'Đã hoàn', key: 'refundedAmount', width: 16 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Trạng thái', key: 'status', width: 20 },
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
      const batch = await this.prisma.supplierReturn.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { code: true, name: true } },
          branch: { select: { name: true } },
          purchaseOrder: { select: { code: true } },
          creator: { select: { name: true } },
          details: { select: { requestQuantity: true } },
        },
      });

      if (batch.length === 0) break;

      for (const r of batch) {
        const totalQuantity = r.details.reduce(
          (s, d) => s + Number(d.requestQuantity),
          0,
        );
        const row = sheet.addRow({
          code: r.code,
          purchaseOrderCode: r.purchaseOrder?.code || '',
          createdAt: fmtDateTime(r.createdAt),
          supplierCode: r.supplier?.code || '',
          supplierName: r.supplier?.name || '',
          branch: r.branch?.name || '',
          createdBy: r.creator?.name || r.createdByName || '',
          totalGoods: r.details.length,
          totalQuantity,
          totalReturnAmount: Number(r.totalReturnAmount) || 0,
          refundAmount: Number(r.refundAmount) || 0,
          refundedAmount: Number(r.refundedAmount) || 0,
          note: r.note || '',
          status: SUPPLIER_RETURN_STATUS_LABELS[r.status] || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildSupplierReturnWhere với export tổng quan.
   */
  async exportSupplierReturnsDetail(
    query: SupplierReturnQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildSupplierReturnWhere(query, supplierScope);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Trả hàng nhập chi tiết');

    sheet.columns = [
      { header: 'Mã trả hàng nhập', key: 'code', width: 18 },
      { header: 'Mã phiếu nhập', key: 'purchaseOrderCode', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Tên nhà cung cấp', key: 'supplierName', width: 24 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người tạo', key: 'createdBy', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 20 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'SL nhập', key: 'purchaseQuantity', width: 12 },
      { header: 'SL yêu cầu trả', key: 'requestQuantity', width: 14 },
      { header: 'SL xác nhận', key: 'confirmedQuantity', width: 12 },
      { header: 'Đơn giá trả', key: 'returnPrice', width: 14 },
      { header: 'Thành tiền', key: 'totalAmount', width: 16 },
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
      const batch = await this.prisma.supplierReturn.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { name: true } },
          branch: { select: { name: true } },
          purchaseOrder: { select: { code: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });

      if (batch.length === 0) break;

      for (const r of batch) {
        const base = {
          code: r.code,
          purchaseOrderCode: r.purchaseOrder?.code || '',
          createdAt: fmtDateTime(r.createdAt),
          supplierName: r.supplier?.name || '',
          branch: r.branch?.name || '',
          createdBy: r.creator?.name || r.createdByName || '',
          status: SUPPLIER_RETURN_STATUS_LABELS[r.status] || '',
        };

        if (!r.details.length) {
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            purchaseQuantity: 0,
            requestQuantity: 0,
            confirmedQuantity: 0,
            returnPrice: 0,
            totalAmount: 0,
            note: '',
          });
          row.commit();
          continue;
        }

        for (const d of r.details) {
          const row = sheet.addRow({
            ...base,
            // Mỗi dòng chi tiết có thể thuộc phiếu nhập riêng (mode by_product),
            // ưu tiên mã phiếu nhập của dòng nếu có.
            purchaseOrderCode: d.purchaseOrderCode || base.purchaseOrderCode,
            productCode: d.productCode || '',
            productName: d.productName || '',
            purchaseQuantity: Number(d.purchaseQuantity) || 0,
            requestQuantity: Number(d.requestQuantity) || 0,
            confirmedQuantity: Number(d.confirmedQuantity) || 0,
            returnPrice: Number(d.returnPrice) || 0,
            totalAmount: Number(d.totalAmount) || 0,
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

  // ─── findOne ─────────────────────────────────────────────────────────────────

  async findOne(id: number, supplierScope?: number | null) {
    const record = await this.prisma.supplierReturn.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, name: true } },
        purchaseOrder: { select: { id: true, code: true, currency: true, exchangeRate: true } },
        creator: { select: { id: true, name: true } },
        exporter: { select: { id: true, name: true } },
        refundConfirmer: { select: { id: true, name: true } },
        cashFlow: { select: { id: true, code: true, amount: true } },
        details: {
          include: {
            product: {
              select: { id: true, code: true, name: true, images: true },
            },
          },
        },
      },
    });

    if (!record)
      throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

    // Scope NCC: chặn nhân viên NCC xem phiếu của nhà cung cấp khác.
    if (supplierScope != null && record.supplierId !== supplierScope) {
      throw new ForbiddenException(
        'Không có quyền xem dữ liệu của nhà cung cấp khác',
      );
    }
    return record;
  }

  // ─── create (Bước 1) ─────────────────────────────────────────────────────────

  async create(dto: CreateSupplierReturnDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      // ── Validate nhà cung cấp ────────────────────────────────────────────
      const supplier = await tx.supplier.findUnique({
        where: { id: dto.supplierId },
      });
      if (!supplier) throw new NotFoundException('Không tìm thấy nhà cung cấp');

      // ── Validate theo mode ───────────────────────────────────────────────
      let monetary = this.normalizeCurrency(dto.currency, dto.exchangeRate);
      if (dto.mode === 'by_purchase_order') {
        if (!dto.purchaseOrderId) {
          throw new BadRequestException(
            'Mode by_purchase_order yêu cầu purchaseOrderId',
          );
        }

        const po = await tx.purchaseOrder.findUnique({
          where: { id: dto.purchaseOrderId },
          include: { items: true },
        });

        if (!po) throw new NotFoundException('Không tìm thấy phiếu nhập hàng');
        if (po.isDraft || po.status === 0) {
          throw new BadRequestException(
            'Phiếu nhập hàng phải ở trạng thái hoàn thành',
          );
        }
        if (po.supplierId !== dto.supplierId) {
          throw new BadRequestException(
            'Phiếu nhập hàng không thuộc nhà cung cấp này',
          );
        }
        monetary = this.normalizeCurrency(po.currency, po.exchangeRate);

        // Lấy số lượng đã trả trước đó (không tính phiếu bị hủy)
        const existingReturns = await tx.supplierReturn.findMany({
          where: {
            purchaseOrderId: dto.purchaseOrderId,
            status: { not: SUPPLIER_RETURN_STATUS.CANCELLED },
          },
          include: { details: true },
        });

        const returnedQtyMap = new Map<number, number>();
        existingReturns.forEach((sr) => {
          sr.details.forEach((d) => {
            const prev = returnedQtyMap.get(d.productId) || 0;
            returnedQtyMap.set(d.productId, prev + Number(d.requestQuantity));
          });
        });

        const poItemMap = new Map(po.items.map((i: any) => [i.productId, i]));

        for (const detail of dto.details) {
          const poItem = poItemMap.get(detail.productId);
          if (!poItem) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productCode} không có trong phiếu nhập`,
            );
          }

          const alreadyReturned = returnedQtyMap.get(detail.productId) || 0;
          const maxReturnable = Number(poItem.quantity) - alreadyReturned;

          if (detail.requestQuantity > maxReturnable) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá có thể trả (${maxReturnable})`,
            );
          }
        }
      } else {
        // by_product — validate theo onHand
        for (const detail of dto.details) {
          const inv = await tx.inventory.findFirst({
            where: { productId: detail.productId, branchId: dto.branchId },
          });

          const onHand = Number(inv?.onHand || 0);
          if (detail.requestQuantity > onHand) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá tồn kho (${onHand})`,
            );
          }
        }
      }

      // ── Tạo phiếu ───────────────────────────────────────────────────────
      const code = await this.generateCode(tx);

      const detailsData = dto.details.map((d) => ({
        purchaseOrderId: d.purchaseOrderId || dto.purchaseOrderId || null,
        purchaseOrderCode: d.purchaseOrderCode || null,
        productId: d.productId,
        productCode: d.productCode,
        productName: d.productName,
        purchaseQuantity: d.purchaseQuantity,
        purchasePrice: d.purchasePrice,
        requestQuantity: d.requestQuantity,
        confirmedQuantity: 0,
        ...this.normalizeDetailAmounts(d, monetary.currency, monetary.exchangeRate),
        note: d.note,
      }));

      const totalReturnAmount = detailsData.reduce(
        (sum, d) => sum + d.totalAmount,
        0,
      );
      const totalForeignReturnAmount = monetary.currency === 'VND'
        ? null
        : this.roundMoney(detailsData.reduce(
            (sum, d) => sum + Number(d.foreignReturnAmount || 0),
            0,
          ));

      const status = dto.isDraft
        ? SUPPLIER_RETURN_STATUS.DRAFT
        : SUPPLIER_RETURN_STATUS.REQUEST;

      const supplierReturn = await tx.supplierReturn.create({
        data: {
          code,
          mode: dto.mode,
          purchaseOrderId: dto.purchaseOrderId || null,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          status,
          statusValue: SUPPLIER_RETURN_STATUS_LABELS[status],
          currency: monetary.currency,
          exchangeRate: monetary.exchangeRate,
          totalReturnAmount,
          totalForeignReturnAmount,
          note: dto.note,
          createdBy: userId,
          createdByName: user?.name || 'System',
          images: dto.images ? JSON.stringify(dto.images) : null,
          details: { create: detailsData },
        },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          branch: { select: { id: true, name: true } },
          details: true,
        },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'SUPPLIER_RETURN_CREATE',
        entityType: 'supplier_returns',
        entityId: supplierReturn.id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: {
          code: supplierReturn.code,
          mode: dto.mode,
          supplierName: supplier.name,
          totalReturnAmount,
          status: SUPPLIER_RETURN_STATUS_LABELS[status],
        },
        message: `Tạo phiếu trả hàng nhập ${supplierReturn.code} cho NCC ${supplier.name}`,
        messageTemplate: 'SUPPLIER_RETURN_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.branchId,
      });

      return supplierReturn;
    });
  }

  async updateStep1(id: number, dto: UpdateStep1Dto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: { details: true },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (supplierReturn.status !== SUPPLIER_RETURN_STATUS.DRAFT) {
        throw new BadRequestException(
          'Chỉ có thể chỉnh sửa phiếu ở trạng thái Phiếu tạm',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      // ── Validate lại theo mode ────────────────────────────────────────────
      let monetary = this.normalizeCurrency(
        supplierReturn.currency,
        supplierReturn.exchangeRate,
      );
      if (
        supplierReturn.mode === 'by_purchase_order' &&
        supplierReturn.purchaseOrderId
      ) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: supplierReturn.purchaseOrderId },
          include: { items: true },
        });

        if (!po) throw new NotFoundException('Không tìm thấy phiếu nhập hàng');
        monetary = this.normalizeCurrency(po.currency, po.exchangeRate);

        const existingReturns = await tx.supplierReturn.findMany({
          where: {
            purchaseOrderId: supplierReturn.purchaseOrderId,
            status: { not: SUPPLIER_RETURN_STATUS.CANCELLED },
            id: { not: id }, // ← exclude phiếu hiện tại
          },
          include: { details: true },
        });

        const returnedQtyMap = new Map<number, number>();
        existingReturns.forEach((sr) => {
          sr.details.forEach((d) => {
            const prev = returnedQtyMap.get(d.productId) || 0;
            returnedQtyMap.set(d.productId, prev + Number(d.requestQuantity));
          });
        });

        const poItemMap = new Map(po.items.map((i: any) => [i.productId, i]));

        for (const detail of dto.details) {
          const poItem = poItemMap.get(detail.productId);
          if (!poItem) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productCode} không có trong phiếu nhập`,
            );
          }
          const alreadyReturned = returnedQtyMap.get(detail.productId) || 0;
          const maxReturnable = Number(poItem.quantity) - alreadyReturned;
          if (detail.requestQuantity > maxReturnable) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá có thể trả (${maxReturnable})`,
            );
          }
        }
      } else if (supplierReturn.mode === 'by_product') {
        for (const detail of dto.details) {
          const inv = await tx.inventory.findFirst({
            where: {
              productId: detail.productId,
              branchId: supplierReturn.branchId,
            },
          });
          const onHand = Number(inv?.onHand || 0);
          if (detail.requestQuantity > onHand) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Số lượng trả (${detail.requestQuantity}) vượt quá tồn kho (${onHand})`,
            );
          }
        }
      }

      // ── Xóa details cũ → tạo lại ─────────────────────────────────────────
      await tx.supplierReturnDetail.deleteMany({
        where: { supplierReturnId: id },
      });

      const detailsData = dto.details
        .filter((d) => d.requestQuantity > 0)
        .map((d) => ({
          purchaseOrderId:
            d.purchaseOrderId || supplierReturn.purchaseOrderId || null,
          purchaseOrderCode: d.purchaseOrderCode || null,
          productId: d.productId,
          productCode: d.productCode,
          productName: d.productName,
          purchaseQuantity: d.purchaseQuantity,
          purchasePrice: d.purchasePrice,
          requestQuantity: d.requestQuantity,
          confirmedQuantity: 0,
          ...this.normalizeDetailAmounts(d, monetary.currency, monetary.exchangeRate),
          note: d.note,
        }));

      await tx.supplierReturnDetail.createMany({
        data: detailsData.map((d) => ({ ...d, supplierReturnId: id })),
      });

      const totalReturnAmount = detailsData.reduce(
        (sum, d) => sum + d.totalAmount,
        0,
      );
      const totalForeignReturnAmount = monetary.currency === 'VND'
        ? null
        : this.roundMoney(detailsData.reduce(
            (sum, d) => sum + Number(d.foreignReturnAmount || 0),
            0,
          ));

      const newStatus = dto.isDraft
        ? SUPPLIER_RETURN_STATUS.DRAFT
        : SUPPLIER_RETURN_STATUS.REQUEST;

      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: newStatus,
          statusValue: SUPPLIER_RETURN_STATUS_LABELS[newStatus],
          currency: monetary.currency,
          exchangeRate: monetary.exchangeRate,
          totalReturnAmount,
          totalForeignReturnAmount,
          note: dto.note ?? supplierReturn.note,
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_UPDATE_STEP1',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: {
          code: supplierReturn.code,
          totalReturnAmount,
          status: SUPPLIER_RETURN_STATUS_LABELS[newStatus],
        },
        message: `Cập nhật phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_UPDATE_STEP1',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });
  }

  // ─── confirmExport (Bước 2) ──────────────────────────────────────────────────

  async confirmExport(id: number, dto: ConfirmExportDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: {
          details: true,
          supplier: { select: { id: true, name: true, contactNumber: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (
        supplierReturn.status !== SUPPLIER_RETURN_STATUS.REQUEST &&
        supplierReturn.status !== SUPPLIER_RETURN_STATUS.DRAFT &&
        supplierReturn.status !== SUPPLIER_RETURN_STATUS.STOCK_EXPORT_DRAFT
      ) {
        throw new BadRequestException(
          'Phiếu trả hàng không ở trạng thái cho phép xuất kho',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      if (dto.isDraft) {
        await tx.supplierReturn.update({
          where: { id },
          data: {
            status: SUPPLIER_RETURN_STATUS.STOCK_EXPORT_DRAFT,
            statusValue:
              SUPPLIER_RETURN_STATUS_LABELS[
                SUPPLIER_RETURN_STATUS.STOCK_EXPORT_DRAFT
              ],
          },
        });
        return this.findOne(id);
      }

      // ── Xử lý từng detail ────────────────────────────────────────────────
      for (const confirmDetail of dto.details) {
        const detail = supplierReturn.details.find(
          (d) => d.id === confirmDetail.detailId,
        );
        if (!detail) continue;

        const confirmedQty = confirmDetail.confirmedQuantity;
        if (confirmedQty <= 0) continue;

        // Đối xứng `return-orders.service.ts:377-381`: confirmedQuantity
        // không được vượt quá requestQuantity. Phía bán block sớm — phía mua
        // trước đây cho qua → user có thể hoàn tiền vượt request.
        if (confirmedQty > Number(detail.requestQuantity)) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Số lượng xuất (${confirmedQty}) vượt quá số lượng yêu cầu (${Number(detail.requestQuantity)})`,
          );
        }

        // Validate tồn kho đủ để xuất
        const inv = await tx.inventory.findFirst({
          where: {
            productId: detail.productId,
            branchId: supplierReturn.branchId,
          },
        });

        if (!inv || Number(inv.onHand) < confirmedQty) {
          throw new BadRequestException(
            `Sản phẩm ${detail.productName}: Tồn kho không đủ để xuất (cần ${confirmedQty}, còn ${inv ? Number(inv.onHand) : 0})`,
          );
        }

        // Validate damaged/nearExpiry buckets nếu user chỉ định loại hàng.
        // Đối xứng `invoices.service.ts:validateConditionQuantity`: chỉ
        // check khi conditionType !== 'normal'.
        const condition = confirmDetail.conditionType || 'normal';
        if (condition === 'damaged') {
          if (Number(inv.damagedQuantity || 0) < confirmedQty) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Tồn kho hàng damaged không đủ (cần ${confirmedQty}, còn ${Number(inv.damagedQuantity || 0)})`,
            );
          }
        } else if (condition === 'near_expiry') {
          if (Number(inv.nearExpiryQuantity || 0) < confirmedQty) {
            throw new BadRequestException(
              `Sản phẩm ${detail.productName}: Tồn kho hàng cận date không đủ (cần ${confirmedQty}, còn ${Number(inv.nearExpiryQuantity || 0)})`,
            );
          }
        }

        // Giảm tồn kho theo conditionType. Đối xứng
        // `invoices.service.ts:buildInventoryDeductData`: trừ `onHand` luôn,
        // trừ thêm bucket damaged/nearExpiry nếu chỉ định.
        const deductData: Record<string, any> = {
          onHand: { decrement: confirmedQty },
        };
        if (condition === 'damaged') {
          deductData.damagedQuantity = { decrement: confirmedQty };
        } else if (condition === 'near_expiry') {
          deductData.nearExpiryQuantity = { decrement: confirmedQty };
        }

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: supplierReturn.branchId,
            },
          },
          data: deductData,
        });
        touchedProductIds.add(detail.productId);

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: supplierReturn.branchId,
            branchName: supplierReturn.branch?.name || '',
            transactionType: 'SUPPLIER_RETURN',
            refCode: supplierReturn.code,
            refType: 'supplier_return',
            refId: supplierReturn.id,
            quantity: -confirmedQty,
            costPrice: Number(inv.cost || 0),
            transactionPrice: Number(detail.returnPrice),
            partnerId: supplierReturn.supplierId,
            partnerName: supplierReturn.supplier?.name || null,
          },
        });

        // Cập nhật confirmedQuantity + conditionType trên detail
        await tx.supplierReturnDetail.update({
          where: { id: detail.id },
          data: {
            confirmedQuantity: confirmedQty,
            conditionType: condition,
          },
        });
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active. Recalc sau khi ghi log
      // SUPPLIER_RETURN cho mọi item (đè decrement rời rạc). damaged/nearExpiry
      // giữ nguyên theo deductData bên trên.
      await recalcOnHandForPairs(
        tx,
        supplierReturn.details.map((d) => ({
          productId: d.productId,
          branchId: supplierReturn.branchId,
        })),
      );

      // ── Tính refundAmount ─────────────────────────────────────────────────
      const updatedDetails = await tx.supplierReturnDetail.findMany({
        where: { supplierReturnId: id },
      });

      const refundAmount = this.roundMoney(updatedDetails.reduce(
        (sum, d) => sum + (
          Number(d.confirmedQuantity) > 0 ? Number(d.totalAmount) : 0
        ),
        0,
      ));
      const refundForeignAmount = supplierReturn.currency === 'VND'
        ? null
        : this.roundMoney(updatedDetails.reduce(
            (sum, d) => sum + (
              Number(d.confirmedQuantity) > 0
                ? Number(d.foreignReturnAmount || 0)
                : 0
            ),
            0,
          ));

      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.STOCK_EXPORTED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[
              SUPPLIER_RETURN_STATUS.STOCK_EXPORTED
            ],
          refundAmount,
          refundForeignAmount,
          exportedById: userId,
          exportedByName: user?.name || 'System',
          exportedAt: new Date(),
          note: dto.note ?? supplierReturn.note,
        },
      });

      // Step 2 đã chuyển status → STOCK_EXPORTED. Formula B đếm RO này vào
      // offsets nên debt sẽ giảm tương ứng `refundAmount`. Đối xứng với KH
      // step 2 STOCK_RECEIVED ở return-orders.service.
      await this.updateSupplierDebt(supplierReturn.supplierId, tx);

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_STOCK_EXPORTED',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: { code: supplierReturn.code, refundAmount },
        message: `Xác nhận xuất kho phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_STOCK_EXPORTED',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  // ─── confirmRefund (Bước 3) ──────────────────────────────────────────────────

  async confirmRefund(id: number, dto: ConfirmRefundDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: {
          details: true,
          supplier: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
            },
          },
          branch: { select: { id: true, name: true } },
          purchaseOrder: {
            select: {
              id: true,
              code: true,
              paidAmount: true,
              total: true,
              discount: true,
              currency: true,
              exchangeRate: true,
            },
          },
        },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (supplierReturn.status !== SUPPLIER_RETURN_STATUS.STOCK_EXPORTED) {
        throw new BadRequestException(
          'Phiếu trả hàng phải ở trạng thái Đã xuất kho',
        );
      }

      if (
        supplierReturn.mode === 'by_product' &&
        dto.refundType === 'debt_offset' &&
        false // bỏ block này vì by_product + debt_offset đã được cho phép
      ) {
        throw new BadRequestException(
          'Trả hàng theo sản phẩm lẻ không hỗ trợ cấn trừ nợ theo phiếu nhập',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      const refundAmount = Number(supplierReturn.refundAmount);
      let cashFlowId: number | null = null;

      // ── Nhánh debt_offset ────────────────────────────────────────────────
      if (dto.refundType === 'debt_offset') {
        if (
          supplierReturn.mode === 'by_purchase_order' &&
          supplierReturn.purchaseOrder
        ) {
          // Tăng paidAmount trên PO gốc → updateSupplierDebt tự recalculate
          const po = supplierReturn.purchaseOrder;
          const newPaidAmount = Number(po.paidAmount) + refundAmount;
          const subTotal = Number(po.total) - Number(po.discount);
          const newDebtAmount = Math.max(0, subTotal - newPaidAmount);

          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: {
              paidAmount: newPaidAmount,
              debtAmount: newDebtAmount,
            },
          });
        }
        // by_product: updateSupplierDebt sẽ tự tính qua supplierReturn.refundedAmount

        // ── Nhánh cash_refund ────────────────────────────────────────────────
      } else if (dto.refundType === 'cash_refund') {
        const cfCode = await this.generateCashFlowCode(true, tx);

        const cashFlow = await tx.cashFlow.create({
          data: {
            code: cfCode,
            branchId: supplierReturn.branchId,
            isReceipt: true,
            amount: refundAmount,
            currency: supplierReturn.currency,
            exchangeRate: Number(supplierReturn.exchangeRate),
            foreignAmount: supplierReturn.refundForeignAmount == null
              ? null
              : Number(supplierReturn.refundForeignAmount),
            transDate: new Date(),
            method: dto.method || 'cash',
            accountId: dto.accountId || null,
            partnerType: 'S',
            partnerId: supplierReturn.supplierId,
            partnerName: supplierReturn.supplier?.name,
            contactNumber: supplierReturn.supplier?.contactNumber,
            address: supplierReturn.supplier?.address,
            cashFlowGroupId: dto.cashFlowGroupId || 8,
            description: `Thu tiền trả hàng nhập ${supplierReturn.code}`,
            status: 0,
            statusValue: 'Đã thu',
            createdBy: userId,
            usedForFinancialReporting: 1,
            supplierDebtSnapshot: null,
          },
        });
        cashFlowId = cashFlow.id;
      }

      // ── Cập nhật Supplier.debt ────────────────────────────────────────────
      await this.updateSupplierDebt(supplierReturn.supplierId, tx);

      // ── Snapshot supplier debt vào CashFlow vừa tạo (cash_refund) ────────
      // Đối xứng `return-orders.service.ts:691-720` (customerDebtSnapshot).
      if (cashFlowId) {
        const updatedSupplier = await tx.supplier.findUnique({
          where: { id: supplierReturn.supplierId },
          select: { debt: true },
        });
        await tx.cashFlow.update({
          where: { id: cashFlowId },
          data: {
            supplierDebtSnapshot: updatedSupplier
              ? Number(updatedSupplier.debt)
              : null,
          },
        });
      }

      // ── Cập nhật trạng thái phiếu ─────────────────────────────────────────
      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.COMPLETED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[SUPPLIER_RETURN_STATUS.COMPLETED],
          refundType: dto.refundType,
          refundedAmount: refundAmount,
          refundedForeignAmount: supplierReturn.refundForeignAmount,
          refundConfirmedBy: userId,
          refundConfirmedByName: user?.name || 'System',
          refundConfirmedAt: new Date(),
          ...(cashFlowId && { cashFlowId }),
        },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_REFUND_CONFIRMED',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'info',
        snapshot: {
          code: supplierReturn.code,
          refundType: dto.refundType,
          refundAmount,
        },
        message: `${dto.refundType === 'cash_refund' ? 'Thu tiền' : 'Cấn trừ nợ'} phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_REFUND_CONFIRMED',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });
  }

  // ─── cancel ──────────────────────────────────────────────────────────────────

  async cancel(id: number, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const supplierReturn = await tx.supplierReturn.findUnique({
        where: { id },
        include: { details: true },
      });

      if (!supplierReturn)
        throw new NotFoundException('Không tìm thấy phiếu trả hàng nhập');

      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.COMPLETED) {
        throw new BadRequestException(
          'Không thể hủy phiếu trả hàng nhập đã hoàn thành',
        );
      }

      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu trả hàng nhập đã bị hủy');
      }

      // Rollback tồn kho nếu đã xuất kho — restore cả damaged/nearExpiry
      // buckets theo conditionType (đối xứng `return-orders.cancel:817-826`).
      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.STOCK_EXPORTED) {
        for (const detail of supplierReturn.details) {
          const confirmedQty = Number(detail.confirmedQuantity);
          if (confirmedQty <= 0) continue;

          const restoreData: Record<string, any> = {
            onHand: { increment: confirmedQty },
          };
          const condition = (detail as any).conditionType || 'normal';
          if (condition === 'damaged') {
            restoreData.damagedQuantity = { increment: confirmedQty };
          } else if (condition === 'near_expiry') {
            restoreData.nearExpiryQuantity = { increment: confirmedQty };
          }

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: supplierReturn.branchId,
              },
            },
            data: restoreData,
          });
          touchedProductIds.add(detail.productId);
        }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      await tx.supplierReturn.update({
        where: { id },
        data: {
          status: SUPPLIER_RETURN_STATUS.CANCELLED,
          statusValue:
            SUPPLIER_RETURN_STATUS_LABELS[SUPPLIER_RETURN_STATUS.CANCELLED],
        },
      });

      // NGUỒN CHÂN LÝ: status=5 → log SUPPLIER_RETURN inactive → recalc cộng
      // lại onHand (damaged/nearExpiry đã restore thủ công ở trên).
      if (supplierReturn.status === SUPPLIER_RETURN_STATUS.STOCK_EXPORTED) {
        await recalcOnHandForPairs(
          tx,
          supplierReturn.details.map((d) => ({
            productId: d.productId,
            branchId: supplierReturn.branchId,
          })),
        );
      }

      // Phiếu bị hủy → loại khỏi offsets của Formula B → recalc để hoàn nợ NCC
      // (đối xứng return-orders.cancel L848-850).
      await this.updateSupplierDebt(supplierReturn.supplierId, tx);

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_RETURN_CANCEL',
        entityType: 'supplier_returns',
        entityId: id.toString(),
        entityCode: supplierReturn.code,
        category: 'supplier_return',
        severity: 'warning',
        snapshot: { code: supplierReturn.code },
        message: `Hủy phiếu trả hàng nhập ${supplierReturn.code}`,
        messageTemplate: 'SUPPLIER_RETURN_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: supplierReturn.branchId,
      });

      return this.findOne(id);
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async importFromExcel(dto: ImportSupplierReturnsDto, userId: number) {
    const results = {
      total: dto.items.length,
      imported: 0,
      updated: 0,
      failed: 0,
      errors: [] as { code: string; error: string }[],
    };

    for (const item of dto.items) {
      try {
        let wasUpdate = false;

        await this.prisma.$transaction(async (tx) => {
          const existing = await tx.supplierReturn.findFirst({
            where: { code: item.code },
          });

          const supplier = await tx.supplier.findFirst({
            where: {
              OR: [{ code: item.supplierCode }, { name: item.supplierName }],
            },
          });
          if (!supplier)
            throw new Error(`NCC "${item.supplierName}" không tìm thấy`);

          const branch = await tx.branch.findFirst({
            where: {
              name: { contains: item.branchName, mode: 'insensitive' },
            },
          });
          if (!branch)
            throw new Error(`Chi nhánh "${item.branchName}" không tìm thấy`);

          const isCompleted = item.statusText !== 'Đã hủy';
          const status = isCompleted
            ? SUPPLIER_RETURN_STATUS.COMPLETED
            : SUPPLIER_RETURN_STATUS.CANCELLED;
          const refundType = isCompleted ? 'debt_offset' : null;
          const refundedAmount = isCompleted ? item.totalReturnAmount : 0;
          const returnedAt = item.returnedAt
            ? new Date(item.returnedAt)
            : new Date();

          const detailsData: any[] = [];
          for (const d of item.details) {
            const product = await tx.product.findFirst({
              where: { code: d.productCode },
            });
            if (!product)
              throw new Error(`Sản phẩm "${d.productCode}" không tìm thấy`);
            detailsData.push({
              productId: product.id,
              productCode: d.productCode,
              productName: d.productName,
              purchaseQuantity: d.quantity,
              purchasePrice: d.returnPrice,
              requestQuantity: d.quantity,
              confirmedQuantity: d.quantity,
              inputMode: 'total_amount',
              returnPrice: d.returnPrice,
              totalAmount: d.totalAmount,
              note: d.note || null,
            });
          }

          if (existing) {
            wasUpdate = true;
            await tx.supplierReturnDetail.deleteMany({
              where: { supplierReturnId: existing.id },
            });
            await tx.supplierReturn.update({
              where: { id: existing.id },
              data: {
                mode: 'by_product',
                supplierId: supplier.id,
                branchId: branch.id,
                status,
                statusValue: SUPPLIER_RETURN_STATUS_LABELS[status],
              totalReturnAmount: item.totalReturnAmount,
                currency: 'VND',
                exchangeRate: 1,
                totalForeignReturnAmount: null,
                refundAmount: item.totalReturnAmount,
                refundForeignAmount: null,
                refundedAmount,
                refundedForeignAmount: null,
                refundType,
                note: item.note || null,
                createdByName:
                  item.createdByName || item.exportedByName || 'Import',
                exportedByName: item.exportedByName || null,
                exportedAt: returnedAt,
                refundConfirmedByName: item.createdByName || null,
                refundConfirmedAt: isCompleted ? returnedAt : null,
                createdAt: returnedAt,
                details: { create: detailsData },
              },
            });
          } else {
            await tx.supplierReturn.create({
              data: {
                code: item.code,
                mode: 'by_product',
                supplierId: supplier.id,
                branchId: branch.id,
                status,
                statusValue: SUPPLIER_RETURN_STATUS_LABELS[status],
                totalReturnAmount: item.totalReturnAmount,
                currency: 'VND',
                exchangeRate: 1,
                totalForeignReturnAmount: null,
                refundAmount: item.totalReturnAmount,
                refundForeignAmount: null,
                refundedAmount,
                refundedForeignAmount: null,
                refundType,
                note: item.note || null,
                createdBy: userId,
                createdByName:
                  item.createdByName || item.exportedByName || 'Import',
                exportedByName: item.exportedByName || null,
                exportedAt: returnedAt,
                refundConfirmedByName: item.createdByName || null,
                refundConfirmedAt: isCompleted ? returnedAt : null,
                createdAt: returnedAt,
                details: { create: detailsData },
              },
            });
          }
        });

        // ✅ Increment SAU KHI transaction thành công, NGOÀI transaction callback
        if (wasUpdate) {
          results.updated++;
        } else {
          results.imported++;
        }
      } catch (e: any) {
        results.failed++;
        results.errors.push({ code: item.code, error: e.message });
      }
    }

    return results; // ✅ Ngoài for loop
  }
}
