import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  INVOICE_STATUS,
  getStatusLabel,
  CreateInvoiceFromOrderDto,
} from './dto';
import {
  ORDER_STATUS,
  getStatusLabel as getOrderStatusLabel,
} from '../orders/dto/order-status.constants';
import { OrdersService } from '../orders/orders.service';
import { ConsignmentsService } from '../consignments/consignments.service';
import {
  CONSIGNMENT_STATUS,
  getStatusLabel as getConsignmentStatusLabel,
} from '../consignments/dto/consignment-status.constants';
import { CreateInvoiceFromConsignmentDto } from '../consignments/dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { recalcCustomerDebt } from 'src/common/customer-debt.util';
import { recalcOnHandForPairs } from 'src/common/inventory-onhand.util';
import {
  BUCKET_DAMAGED,
  BUCKET_NEAR_EXPIRY,
  BUCKET_PROMO,
  computeBucketTotals,
  computeNearExpiryLots,
  recalcConditionBucketsForPairs,
} from 'src/common/stock-condition-onhand.util';
import { searchCustomerIds } from '../common/customer-search.util';
import { parseDocumentQrPayload } from '../common/document-qr.util';
import { resolveDeliveryAddress } from '../common/address-resolver.util';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
} from '../common/inventory-log.util';
import { computeInvoiceVat, computeLineVat } from '../misa-sync/misa-vat.util';
import { PackingSlipsService } from '../packing-slips/packing-slips.service';
import { PromotionsService } from '../promotions/promotions.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
    private consignmentsService: ConsignmentsService,
    private auditLogsService: AuditLogsService,
    private packingSlipsService: PackingSlipsService,
    private promotionsService: PromotionsService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  async resolveScan(
    payload: string,
    packingType: 'packing-slip' | 'packing-hang' | 'packing-loading',
    user: any,
  ) {
    const parsed = parseDocumentQrPayload(payload);
    const select = {
      id: true,
      code: true,
      branchId: true,
      grandTotal: true,
      status: true,
      customer: { select: { id: true, name: true } },
    };

    const document =
      parsed.kind === 'invoice'
        ? await this.prisma.invoice.findUnique({
            where: { code: parsed.code },
            select: { ...select, purchaseDate: true },
          })
        : await this.prisma.consignment.findUnique({
            where: { code: parsed.code },
            select: { ...select, consignDate: true },
          });

    if (!document) throw new NotFoundException('Không tìm thấy chứng từ');

    if (
      parsed.kind === 'invoice' &&
      packingType !== 'packing-slip' &&
      ([INVOICE_STATUS.DELIVERED, INVOICE_STATUS.COMPLETED] as number[]).includes(
        document.status,
      )
    ) {
      throw new BadRequestException('Hóa đơn đã giao hoặc đã hoàn thành');
    }
    if (
      parsed.kind === 'consignment' &&
      ![
        CONSIGNMENT_STATUS.CONFIRMED,
        CONSIGNMENT_STATUS.PACKED,
        CONSIGNMENT_STATUS.LOADING,
        CONSIGNMENT_STATUS.DELIVERED,
      ].includes(document.status as 2 | 3 | 4 | 5)
    ) {
      throw new BadRequestException('Phiếu ký gửi không khả dụng cho báo đơn');
    }

    const allowedBranchIds: number[] = user?.branchIds || [];
    const canAccessAllBranches =
      user?.roles?.includes('Super Admin') || allowedBranchIds.length === 0;
    if (
      document.branchId == null ||
      (!canAccessAllBranches && !allowedBranchIds.includes(document.branchId))
    ) {
      throw new ForbiddenException('Bạn không có quyền truy cập chi nhánh này');
    }

    return {
      kind: parsed.kind,
      id: document.id,
      code: document.code,
      branchId: document.branchId,
      grandTotal: Number(document.grandTotal),
      purchaseDate:
        parsed.kind === 'invoice'
          ? (document as any).purchaseDate
          : (document as any).consignDate,
      customer: document.customer,
    };
  }

  /**
   * Tách logic build `where` để dùng chung giữa findAll và getTotals.
   * Mọi filter (status/branch/date/payment/advanced search...) áp lên cả 2.
   */
  private async buildInvoiceListWhere(
    query: InvoiceQueryDto,
    currentUser?: any,
  ): Promise<any> {
    const {
      search,
      customerIds,
      branchId,
      branchIds,
      statusIds,
      fromDate,
      toDate,
      deliveryStatus,
      paymentMethod,
      bankAccountIds,
      fromPurchaseDate,
      toPurchaseDate,
      fromCreatedDate,
      toCreatedDate,
      fromUpdatedDate,
      toUpdatedDate,
      invoiceCodeSearch,
      productSearch,
      customerSearch,
      deliveryCodeSearch,
      orderCodeSearch,
      descriptionSearch,
      productNoteSearch,
    } = query;

    const where: any = {};

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    }

    if (search) {
      const matchedIds = await searchCustomerIds(this.prisma, search);
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // ── Advanced search filters ──
    if (invoiceCodeSearch) {
      where.code = { contains: invoiceCodeSearch, mode: 'insensitive' };
    }

    if (customerSearch) {
      const matchedIds = await searchCustomerIds(this.prisma, customerSearch);
      const ids = matchedIds.length > 0 ? matchedIds : [-1];
      where.customerId = where.customerId?.in
        ? { in: where.customerId.in.filter((id: number) => ids.includes(id)) }
        : { in: ids };
    }

    if (deliveryCodeSearch) {
      where.delivery = {
        ...where.delivery,
        deliveryCode: { contains: deliveryCodeSearch, mode: 'insensitive' },
      };
    }

    if (orderCodeSearch) {
      where.order = {
        code: { contains: orderCodeSearch, mode: 'insensitive' },
      };
    }

    if (descriptionSearch) {
      where.description = { contains: descriptionSearch, mode: 'insensitive' };
    }

    const detailsConditions: any = {};
    if (productSearch) {
      detailsConditions.OR = [
        { productCode: { contains: productSearch, mode: 'insensitive' } },
        { productName: { contains: productSearch, mode: 'insensitive' } },
      ];
    }
    if (productNoteSearch) {
      detailsConditions.note = {
        contains: productNoteSearch,
        mode: 'insensitive',
      };
    }
    if (Object.keys(detailsConditions).length > 0) {
      where.details = { some: detailsConditions };
    }

    if (customerIds && customerIds.length > 0) {
      where.customerId = where.customerId?.in
        ? {
            in: where.customerId.in.filter((id: number) =>
              customerIds.includes(id),
            ),
          }
        : { in: customerIds };
    }

    if (query.parentCustomerId) {
      where.parentCustomerId = query.parentCustomerId;
    }

    if (branchIds?.length) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }

    if (statusIds && statusIds.length > 0) {
      where.status = { in: statusIds };
    }

    if (fromDate || toDate || fromPurchaseDate || toPurchaseDate) {
      where.purchaseDate = {};
      if (fromDate) where.purchaseDate.gte = new Date(fromDate);
      if (toDate) where.purchaseDate.lte = new Date(toDate);
      if (fromPurchaseDate) where.purchaseDate.gte = new Date(fromPurchaseDate);
      if (toPurchaseDate) where.purchaseDate.lte = new Date(toPurchaseDate);
    }

    if (deliveryStatus === 'none') {
      where.delivery = { is: null };
    } else if (deliveryStatus === 'pending') {
      where.delivery = {
        ...where.delivery,
        status: 1,
      };
    } else if (deliveryStatus === 'delivered') {
      where.delivery = {
        ...where.delivery,
        status: { not: 1 },
      };
    }

    if (paymentMethod) {
      const paymentWhere: any = { paymentMethod };
      if (bankAccountIds && bankAccountIds.length > 0) {
        paymentWhere.accountId = { in: bankAccountIds };
      }
      where.payments = { some: paymentWhere };
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    if (fromUpdatedDate || toUpdatedDate) {
      where.updatedAt = {};
      if (fromUpdatedDate) where.updatedAt.gte = new Date(fromUpdatedDate);
      if (toUpdatedDate) where.updatedAt.lte = new Date(toUpdatedDate);
    }

    // Filter theo người tạo (chỉ áp dụng khi user có quyền xem data người khác)
    if (query.createdByIds?.length && !where.createdBy) {
      where.createdBy = { in: query.createdByIds };
    }

    if (query.soldByIds?.length) {
      where.soldById = { in: query.soldByIds };
    }

    if (query.saleChannelId) {
      where.saleChannelId = query.saleChannelId;
    }

    if (query.misaSyncStatus?.length) {
      where.misaSyncStatus = { in: query.misaSyncStatus };
    }

    // Lọc theo nhân viên phụ trách (Misa): hóa đơn có khách hàng được map tới
    // nhân viên này qua customer.misaEmployeeCode (cùng nguồn dữ liệu đẩy Misa).
    if (query.misaEmployeeCodes?.length) {
      where.customer = {
        ...(where.customer || {}),
        misaEmployeeCode: { in: query.misaEmployeeCodes },
      };
    }

    // Lọc theo trạng thái mã số thuế khách hàng. Khớp đúng cột "Mã số thuế"
    // hiển thị ở bảng: lấy taxCode, fallback sang identificationNumber.
    // - 'empty': cả hai field đều trống/null.
    // - 'filled': có ít nhất một trong hai field.
    // Gộp vào customer.AND để không ghi đè filter customer khác (search/misa).
    if (query.taxCodeStatus === 'empty' || query.taxCodeStatus === 'filled') {
      const taxCondition =
        query.taxCodeStatus === 'empty'
          ? {
              AND: [
                { OR: [{ taxCode: null }, { taxCode: '' }] },
                {
                  OR: [
                    { identificationNumber: null },
                    { identificationNumber: '' },
                  ],
                },
              ],
            }
          : {
              OR: [
                {
                  AND: [{ taxCode: { not: null } }, { taxCode: { not: '' } }],
                },
                {
                  AND: [
                    { identificationNumber: { not: null } },
                    { identificationNumber: { not: '' } },
                  ],
                },
              ],
            };
      where.customer = {
        ...(where.customer || {}),
        AND: [...(where.customer?.AND || []), taxCondition],
      };
    }

    // Lọc hóa đơn có cảnh báo lệch giá bảng giá 2/3.
    // Phản chiếu đúng logic hiển thị icon ở client (useInvoicePriceBookWarnings):
    // - status <> 2 (chưa hủy)
    // - priceBookId ∈ {2, 3}
    // - có ≥1 dòng sản phẩm mà (price - discount) < giá niêm yết của sản phẩm
    //   đó trong CHÍNH bảng giá của hóa đơn (chỉ xét dòng bảng giá đang active;
    //   sản phẩm không có trong bảng giá → bỏ qua nhờ EXISTS).
    // Lấy tập id rồi giao (AND) với các filter còn lại qua where.id; phân trang
    // và đếm tổng vẫn do Prisma xử lý ở findAll/getTotals như bình thường.
    if (query.priceWarning) {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT i.id FROM invoices i
        WHERE i.status <> 2 AND i."priceBookId" IN (2, 3)
          AND EXISTS (
            SELECT 1 FROM invoice_details d
            JOIN price_book_details pbd
              ON pbd."productId" = d."productId"
             AND pbd."priceBookId" = i."priceBookId"
             AND pbd."isActive" = true
            WHERE d."invoiceId" = i.id
              AND (d.price - d.discount) < pbd.price
          )`;
      const ids = rows.map((r) => Number(r.id));
      where.id = { in: ids.length ? ids : [-1] };
    }

    return where;
  }

  /**
   * Tổng các cột tiền của TOÀN BỘ hóa đơn match filter (không phân trang).
   * Dùng cho hàng "tổng" hiển thị ngay dưới header bảng hóa đơn.
   *
   * - totalAmount/grandTotal/paidAmount/debtAmount: aggregate trực tiếp từ DB
   * - returnOrderAmount/cashRefundAmount/debtOffsetAmount/remainingAmount:
   *   dùng `calculateReturnSummary` cho từng invoice rồi cộng dồn — không thể
   *   aggregate sum thuần vì `debtOffsetAmount` phụ thuộc credit per-invoice
   *   (Math.min(totalDebtOffset, credit)) và `remainingAmount` cũng phải tính
   *   theo từng invoice. Cộng tổng raw sẽ sai cho hóa đơn có credit > 0.
   */
  async getTotals(query: InvoiceQueryDto, currentUser?: any) {
    const where = await this.buildInvoiceListWhere(query, currentUser);

    // Aggregate các cột raw từ DB
    const agg = await this.prisma.invoice.aggregate({
      where,
      _sum: {
        totalAmount: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
      },
      _count: { _all: true },
    });

    // Lấy minimum data để tính 4 trường computed per-invoice rồi cộng dồn.
    // Chỉ select những field thực sự cần để tránh kéo về quá nhiều dữ liệu.
    //
    // ⚠ Phải chia batch theo cursor: khi where rất rộng (vd: không filter gì) số
    // hóa đơn match có thể vượt 32k. Prisma sẽ load parent xong rồi nested
    // `returnOrders` query với `WHERE invoiceId IN (id1, ..., idN)` — mỗi id là
    // 1 bind variable, dễ vượt giới hạn 32767 của PostgreSQL prepared statement
    // (`too many bind variables in prepared statement`).
    const BATCH_SIZE = 5000;
    let returnOrderAmount = 0;
    let cashRefundAmount = 0;
    let debtOffsetAmount = 0;
    let remainingAmount = 0;
    let cursor: { id: number } | undefined;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        select: {
          id: true,
          grandTotal: true,
          paidAmount: true,
          returnOrders: {
            where: {
              status: { gte: 2, not: 5 },
              code: { startsWith: 'TH' },
            },
            select: {
              code: true,
              status: true,
              refundAmount: true,
              refundedAmount: true,
              refundType: true,
            },
          },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor, skip: 1 } : {}),
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        const summary = this.calculateReturnSummary(
          inv.returnOrders || [],
          Number(inv.grandTotal),
          Number(inv.paidAmount),
        );
        returnOrderAmount += summary.returnOrderAmount;
        cashRefundAmount += summary.cashRefundAmount;
        debtOffsetAmount += summary.debtOffsetAmount;
        remainingAmount += summary.remainingAmount;
      }

      if (batch.length < BATCH_SIZE) break;
      cursor = { id: batch[batch.length - 1].id };
    }

    const totalAmount = Number(agg._sum.totalAmount || 0);
    const grandTotal = Number(agg._sum.grandTotal || 0);
    const paidAmount = Number(agg._sum.paidAmount || 0);
    const debtAmount = Number(agg._sum.debtAmount || 0);

    return {
      count: agg._count._all,
      totalAmount,
      grandTotal,
      // "Khách cần trả" trên FE đang map về grandTotal — giữ nhất quán.
      customerDebt: grandTotal,
      paidAmount,
      debtAmount,
      returnOrderAmount,
      cashRefundAmount,
      debtOffsetAmount,
      remainingAmount,
    };
  }

  async findAll(query: InvoiceQueryDto, currentUser?: any) {
    const {
      page = 1,
      limit = 15,
      pageSize,
      currentItem,
      orderBy: rawOrderBy,
      orderDirection: rawOrderDirection,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where = await this.buildInvoiceListWhere(query, currentUser);

    // ── Sort logic ──
    const COMPUTED_SORT_FIELDS = [
      'returnOrderAmount',
      'cashRefundAmount',
      'debtOffsetAmount',
      'remainingAmount',
    ];
    const DB_SORT_FIELDS: Record<string, string> = {
      purchaseDate: 'purchase_date',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      grandTotal: 'grand_total',
      paidAmount: 'paid_amount',
    };

    const sortField =
      rawOrderBy &&
      (COMPUTED_SORT_FIELDS.includes(rawOrderBy) || DB_SORT_FIELDS[rawOrderBy])
        ? rawOrderBy
        : 'createdAt';
    const sortDir = rawOrderDirection === 'asc' ? 'asc' : 'desc';
    const isComputedSort = COMPUTED_SORT_FIELDS.includes(sortField);

    const includeConfig = {
      customer: true,
      branch: { select: { id: true, name: true } },
      soldBy: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
      order: { select: { id: true, code: true } },
      details: { include: { product: true } },
      payments: true,
      delivery: true,
      returnOrders: {
        where: {
          status: { gte: 2, not: 5 }, // Đã nhập kho trở lên, loại trừ Đã hủy (5)
          code: { startsWith: 'TH' }, // CHỈ LẤY PHIẾU TRẢ HÀNG, KHÔNG LẤY CTN
        },
        select: {
          id: true,
          code: true,
          status: true,
          refundAmount: true,
          refundedAmount: true,
          refundType: true,
        },
      },
    } as const;

    let data: any[];
    let total: number;

    if (isComputedSort) {
      // Sort theo computed field: build WHERE conditions trực tiếp trong raw SQL
      // để tránh fetch all ids vào memory
      let aggregateExpr: string;
      if (sortField === 'returnOrderAmount') {
        aggregateExpr = `COALESCE(SUM(CASE WHEN ro.status >= 2 AND ro.status <> 5 AND ro.code LIKE 'TH%' THEN ro."refundAmount" ELSE 0 END), 0)`;
      } else if (sortField === 'cashRefundAmount') {
        aggregateExpr = `COALESCE(SUM(CASE WHEN ro.status = 4 AND ro."refundType" = 'cash_refund' AND ro.code LIKE 'TH%' THEN ro."refundedAmount" ELSE 0 END), 0)`;
      } else if (sortField === 'debtOffsetAmount') {
        aggregateExpr = `COALESCE(SUM(CASE WHEN ro.status = 4 AND ro."refundType" = 'debt_offset' AND ro.code LIKE 'TH%' THEN ro."refundAmount" ELSE 0 END), 0)`;
      } else {
        // remainingAmount ≈ grand_total - paid_amount - returnOrderAmount
        aggregateExpr = `(i."grandTotal" - i."paidAmount" - COALESCE(SUM(CASE WHEN ro.status >= 2 AND ro.status <> 5 AND ro.code LIKE 'TH%' THEN ro."refundAmount" ELSE 0 END), 0))`;
      }

      const sortDirSql = sortDir === 'asc' ? 'ASC' : 'DESC';

      // Build WHERE conditions cho raw SQL từ where object
      const sqlConditions: string[] = [];
      const sqlParams: any[] = [];

      if (where.createdBy !== undefined) {
        if (where.createdBy?.in) {
          sqlParams.push(where.createdBy.in);
          sqlConditions.push(`i."createdBy" = ANY($${sqlParams.length})`);
        } else {
          sqlParams.push(where.createdBy);
          sqlConditions.push(`i."createdBy" = $${sqlParams.length}`);
        }
      }
      if (where.customerId?.in) {
        sqlParams.push(where.customerId.in);
        sqlConditions.push(`i."customerId" = ANY($${sqlParams.length})`);
      }
      if (where.parentCustomerId !== undefined) {
        sqlParams.push(where.parentCustomerId);
        sqlConditions.push(`i."parentCustomerId" = $${sqlParams.length}`);
      }
      if (where.branchId?.in) {
        sqlParams.push(where.branchId.in);
        sqlConditions.push(`i."branchId" = ANY($${sqlParams.length})`);
      } else if (typeof where.branchId === 'number') {
        sqlParams.push(where.branchId);
        sqlConditions.push(`i."branchId" = $${sqlParams.length}`);
      }
      if (where.status?.in) {
        sqlParams.push(where.status.in);
        sqlConditions.push(`i.status = ANY($${sqlParams.length})`);
      }
      if (where.purchaseDate?.gte) {
        sqlParams.push(where.purchaseDate.gte);
        sqlConditions.push(`i."purchaseDate" >= $${sqlParams.length}`);
      }
      if (where.purchaseDate?.lte) {
        sqlParams.push(where.purchaseDate.lte);
        sqlConditions.push(`i."purchaseDate" <= $${sqlParams.length}`);
      }
      if (where.createdAt?.gte) {
        sqlParams.push(where.createdAt.gte);
        sqlConditions.push(`i."createdAt" >= $${sqlParams.length}`);
      }
      if (where.createdAt?.lte) {
        sqlParams.push(where.createdAt.lte);
        sqlConditions.push(`i."createdAt" <= $${sqlParams.length}`);
      }
      if (where.soldById !== undefined) {
        if (where.soldById?.in) {
          sqlParams.push(where.soldById.in);
          sqlConditions.push(`i."soldById" = ANY($${sqlParams.length})`);
        } else {
          sqlParams.push(where.soldById);
          sqlConditions.push(`i."soldById" = $${sqlParams.length}`);
        }
      }
      if (where.saleChannelId !== undefined) {
        sqlParams.push(where.saleChannelId);
        sqlConditions.push(`i."saleChannelId" = $${sqlParams.length}`);
      }

      const whereClause =
        sqlConditions.length > 0 ? `WHERE ${sqlConditions.join(' AND ')}` : '';

      // Count query
      const countResult = await this.prisma.$queryRawUnsafe<
        { count: bigint }[]
      >(
        `SELECT COUNT(DISTINCT i.id) as count FROM invoices i ${whereClause}`,
        ...sqlParams,
      );
      total = Number(countResult[0]?.count ?? 0);

      // Sorted ids query
      sqlParams.push(effectiveLimit);
      sqlParams.push(effectiveSkip);
      const sortedIdsRaw = await this.prisma.$queryRawUnsafe<{ id: number }[]>(
        `SELECT i.id
         FROM invoices i
         LEFT JOIN return_orders ro ON ro."invoiceId" = i.id
         ${whereClause}
         GROUP BY i.id, i."grandTotal", i."paidAmount"
         ORDER BY ${aggregateExpr} ${sortDirSql}
         LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
        ...sqlParams,
      );

      const sortedIds = sortedIdsRaw.map((r) => Number(r.id));

      if (sortedIds.length === 0) {
        data = [];
      } else {
        const unsortedData = await this.prisma.invoice.findMany({
          where: { id: { in: sortedIds } },
          include: includeConfig,
        });
        const dataMap = new Map(unsortedData.map((inv) => [inv.id, inv]));
        data = sortedIds.map((id) => dataMap.get(id)).filter(Boolean);
      }
    } else {
      // Sort theo DB field thông thường — dùng Prisma orderBy
      const prismaOrderBy = { [sortField]: sortDir };

      [data, total] = await Promise.all([
        this.prisma.invoice.findMany({
          where,
          skip: effectiveSkip,
          take: effectiveLimit,
          include: includeConfig,
          orderBy: prismaOrderBy,
        }),
        this.prisma.invoice.count({ where }),
      ]);
    }

    // Tính toán 4 trường mới cho mỗi invoice
    const dataWithReturnCalculations = data.map((invoice) => {
      const returnSummary = this.calculateReturnSummary(
        invoice.returnOrders || [],
        Number(invoice.grandTotal),
        Number(invoice.paidAmount),
      );

      return {
        ...invoice,
        returnOrderAmount: returnSummary.returnOrderAmount,
        cashRefundAmount: returnSummary.cashRefundAmount,
        debtOffsetAmount: returnSummary.debtOffsetAmount,
        remainingAmount: returnSummary.remainingAmount,
      };
    });

    return { data: dataWithReturnCalculations, total };
  }

  /**
   * Danh sách hóa đơn cho trang /don-hang/hoa-don-vat.
   * Tái dùng nguyên filter `buildInvoiceListWhere`, nhưng mỗi hóa đơn được gắn
   * thêm khối `vat` (tiền trước thuế / VAT 8% / sau thuế) tính theo đúng logic
   * misa-voucher.service (qua computeInvoiceVat) + các field đồng bộ Misa.
   *
   * VAT chỉ tính trên các dòng có `product.misa_code` để khớp với voucher thật.
   */
  async findAllVat(query: InvoiceQueryDto, currentUser?: any) {
    const { page = 1, limit = 15, pageSize, currentItem } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where = await this.buildInvoiceListWhere(query, currentUser);

    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        skip: effectiveSkip,
        take: effectiveLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
              taxCode: true,
              identificationNumber: true,
              invoiceAddress: true,
              misaEmployeeId: true,
              misaEmployeeCode: true,
              misaEmployeeName: true,
            },
          },
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  vat: true,
                  misa_code: true,
                  misa_name: true,
                  misa_unit: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    const dataWithVat = data.map((invoice) => {
      // Tính VAT theo từng dòng sản phẩm (đúng nghiệp vụ kế toán) rồi cộng dồn.
      const vat = computeInvoiceVat(
        (invoice.details || []).map((d) => ({
          quantity: d.quantity,
          price: d.price,
          discount: d.discount,
          vatRate: Number((d.product as any)?.vat ?? 8),
        })),
      );
      const missingMisaCode = (invoice.details || []).some(
        (d) => !d.product?.misa_code || d.product.misa_code.trim() === '',
      );

      return {
        ...invoice,
        vat: {
          totalPreTax: vat.totalPreTax,
          totalVat: vat.totalVat,
          totalAfterTax: vat.totalAfterTax,
        },
        missingMisaCode,
      };
    });

    return { data: dataWithVat, total };
  }

  /**
   * Tổng các cột VAT của TOÀN BỘ hóa đơn match filter (không phân trang).
   * Dùng cho hàng "tổng" dưới header bảng hóa đơn VAT.
   *
   * VAT tính theo từng dòng sản phẩm (computeInvoiceVat — đúng nghiệp vụ kế
   * toán, khớp với voucher đẩy Misa) rồi cộng dồn. Batch theo cursor để tránh
   * vượt giới hạn bind variable của PostgreSQL khi where rộng.
   */
  async getVatTotals(query: InvoiceQueryDto, currentUser?: any) {
    const where = await this.buildInvoiceListWhere(query, currentUser);

    const BATCH_SIZE = 5000;
    let count = 0;
    let totalPreTax = 0;
    let totalVat = 0;
    let totalAfterTax = 0;
    let cursor: { id: number } | undefined;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        select: {
          id: true,
          details: {
            select: {
              quantity: true,
              price: true,
              discount: true,
              product: { select: { vat: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor, skip: 1 } : {}),
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        count += 1;
        const vat = computeInvoiceVat(
          (inv.details || []).map((d) => ({
            quantity: d.quantity,
            price: d.price,
            discount: d.discount,
            vatRate: Number((d.product as any)?.vat ?? 8),
          })),
        );
        totalPreTax += vat.totalPreTax;
        totalVat += vat.totalVat;
        totalAfterTax += vat.totalAfterTax;
      }

      if (batch.length < BATCH_SIZE) break;
      cursor = { id: batch[batch.length - 1].id };
    }

    return { count, totalPreTax, totalVat, totalAfterTax };
  }

  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
        branch: true,
        soldBy: true,
        creator: true,
        details: {
          include: {
            product: { include: { inventories: true } },
            promotion: { select: { id: true, code: true, name: true } },
          },
        },
        payments: true,
        paymentNotes: { orderBy: { createdAt: 'desc' } },
        delivery: true,
        _count: { select: { returnOrders: true } },
        returnOrders: {
          where: { code: { startsWith: 'TH' } },
          select: {
            id: true,
            code: true,
            status: true,
            refundAmount: true,
            refundedAmount: true,
            refundType: true,
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found`);
    }

    const returnSummary = this.calculateReturnSummary(
      invoice.returnOrders,
      Number(invoice.grandTotal),
      Number(invoice.paidAmount),
    );

    return {
      ...invoice,
      returnOrderAmount: returnSummary.returnOrderAmount,
      cashRefundAmount: returnSummary.cashRefundAmount,
      debtOffsetAmount: returnSummary.debtOffsetAmount,
      remainingAmount: returnSummary.remainingAmount,
    };
  }

  /**
   * Dựng danh sách dòng quà từ lựa chọn của thu ngân cho KM requiresChoice.
   * - Cộng dồn (choice.rewardSelections): phân bổ theo suất, mỗi SP quà nhận
   *   rewardTimes × perTime; validate tổng suất ≤ số suất đạt được (r.rewardTimes).
   * - Single choice (choice.giftProductId): giữ hành vi cũ (1 SP nhận toàn bộ).
   * Mọi SP quà đều phải thuộc rewardOptions và được cap theo opt.remaining.
   *
   * Đơn vị: qty tính theo đơn vị CT (gói với unit, thùng với carton). Trước khi
   * ghi dòng, quy về GÓI thực tế: carton → qty × opt.conversionValue (số gói/thùng
   * của SP quà) để lưu/kho đúng số lượng bán lẻ.
   */
  private resolveChoiceGiftLines(r: any, choice: any, perTime: number): any[] {
    if (!choice) return [];
    const optOf = (productId: number) =>
      (r.rewardOptions || []).find((o: any) => o.productId === productId);
    // carton: số thùng → số gói theo conversionValue của SP quà. unit: giữ gói.
    const isCarton = r.unitMode === 'carton';
    const toGoi = (qtyThung: number, opt: any) =>
      isCarton
        ? Math.round(qtyThung * Number(opt?.conversionValue || 1))
        : qtyThung;

    // ── KM cộng dồn: phân bổ nhiều SP quà theo suất ──
    if (
      Array.isArray(choice.rewardSelections) &&
      choice.rewardSelections.length
    ) {
      const totalTimes = Number(r.rewardTimes || 0);
      const requestedTimes = choice.rewardSelections.reduce(
        (s: number, sel: any) => s + Number(sel.rewardTimes || 0),
        0,
      );
      if (requestedTimes > totalTimes) {
        throw new BadRequestException(
          `PROMOTION_CHANGED: số suất quà đã chọn (${requestedTimes}) vượt số suất đạt được (${totalTimes}) của chương trình "${r.name}"`,
        );
      }
      const lines: any[] = [];
      for (const sel of choice.rewardSelections) {
        const times = Number(sel.rewardTimes || 0);
        if (times <= 0) continue;
        const opt = optOf(sel.productId);
        if (!opt) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: sản phẩm tặng đã chọn không thuộc chương trình "${r.name}"`,
          );
        }
        let qty = times * perTime; // đơn vị CT (gói/thùng)
        if (opt.remaining != null) qty = Math.min(qty, Number(opt.remaining));
        const qtyGoi = toGoi(qty, opt);
        if (qtyGoi <= 0) continue;
        lines.push({
          productId: opt.productId,
          productName: opt.productName,
          quantity: qtyGoi,
          price: 0,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
        });
      }
      return lines;
    }

    // ── Single choice (legacy): 1 SP nhận toàn bộ rewardQuantity ──
    if (choice.giftProductId) {
      const opt = optOf(choice.giftProductId);
      if (!opt) {
        throw new BadRequestException(
          `PROMOTION_CHANGED: sản phẩm tặng đã chọn không thuộc chương trình "${r.name}"`,
        );
      }
      let qty = Math.min(
        Number(choice.giftQuantity || r.rewardQuantity),
        Number(r.rewardQuantity),
      );
      if (opt.remaining != null) qty = Math.min(qty, Number(opt.remaining));
      const qtyGoi = toGoi(qty, opt);
      if (qtyGoi <= 0) return [];
      return [
        {
          productId: opt.productId,
          productName: opt.productName,
          quantity: qtyGoi,
          price: 0,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
        },
      ];
    }

    return [];
  }

  /**
   * Re-validate + dựng danh sách dòng hàng hiệu dụng theo khuyến mãi.
   * - Dòng gift do FE gửi bị bỏ, BE tự sinh lại từ engine (authoritative).
   * - Dòng discounted_buy của FE được validate với engine (sai → PROMOTION_CHANGED).
   * - Dòng thường khớp PRODUCT/CATEGORY_DISCOUNT sẽ được cộng thêm discount.
   * Trả về { effectiveItems, extraInvoiceDiscount, logs }.
   */
  private async processPromotions(
    tx: any,
    dto: CreateInvoiceDto,
    opts?: { reconstructCumulativeChoices?: boolean },
  ): Promise<{
    effectiveItems: any[];
    extraInvoiceDiscount: number;
    logs: any[];
  }> {
    // Gom SL quà (theo GÓI) mà FE gửi lên theo promotionId, TRƯỚC khi lọc bỏ dòng
    // gift engine. Dùng để tái dựng rewardSelections cho KM cộng dồn cần chọn quà
    // khi FE gửi thiếu choice (race: tab HĐ-từ-đơn chưa hydrate opt-in cấp tab).
    // Chỉ dùng khi opts.reconstructCumulativeChoices=true (luồng createFromOrder).
    const feGiftQtyByPromoProduct = new Map<number, Map<number, number>>();
    if (opts?.reconstructCumulativeChoices) {
      for (const it of dto.items) {
        const isGift = !!(it.isGift || (it.lineType || 'normal') === 'gift');
        if (!isGift || it.promotionId == null) continue;
        const pid = Number(it.promotionId);
        const inner = feGiftQtyByPromoProduct.get(pid) || new Map<number, number>();
        inner.set(
          Number(it.productId),
          (inner.get(Number(it.productId)) || 0) + Number(it.quantity || 0),
        );
        feGiftQtyByPromoProduct.set(pid, inner);
      }
    }

    // Bỏ dòng gift do KM engine sinh (có promotionId) — BE tự sinh lại.
    // GIỮ dòng gift thủ công (thu ngân đánh dấu 🎁, không gắn promotionId).
    const baseItems: any[] = dto.items
      .filter(
        (it) => (it.lineType || 'normal') !== 'gift' || it.promotionId == null,
      )
      .map((it) => {
        const lineType = it.lineType || 'normal';
        const manualGift = lineType === 'gift' && it.promotionId == null;
        // promotionId trên dòng 'normal' chỉ là "trigger stamp" phái sinh (mục 2b) —
        // engine sẽ tự gán lại. Reset về null để tránh giữ stamp sai từ dữ liệu cũ
        // (dòng thường không phải hàng X bị dính promotionId của quà cùng mã SP).
        // Giữ nguyên cho discounted_buy (cần để validate) và gift thủ công.
        const derivedNormalStamp = lineType === 'normal';
        return {
          productId: it.productId,
          productCode: it.productCode,
          productName: it.productName,
          quantity: Number(it.quantity),
          price: manualGift ? 0 : Number(it.price),
          discount: manualGift ? 0 : Number(it.discount || 0),
          discountRatio: Number(it.discountRatio || 0),
          totalPrice: manualGift ? 0 : Number(it.totalPrice),
          note: it.note,
          conditionType: it.conditionType || 'normal',
          soldExpiryDate: it.soldExpiryDate ? new Date(it.soldExpiryDate) : null,
          lineType: manualGift ? 'gift' : it.lineType || 'normal',
          isGift: manualGift,
          promotionId: derivedNormalStamp ? null : (it.promotionId ?? null),
          triggerProductId: it.triggerProductId,
          enabledPromotionIds: it.enabledPromotionIds,
        };
      });

    if (dto.skipPromotions || !dto.branchId) {
      return { effectiveItems: baseItems, extraInvoiceDiscount: 0, logs: [] };
    }

    // Một CTKM có thể áp độc lập cho nhiều mã X. Key phải gồm cả mã X kích hoạt,
    // nếu chỉ dùng promotionId thì lựa chọn của dòng sau sẽ ghi đè dòng trước.
    const choiceKey = (promotionId: number, triggerProductId?: number | null) =>
      `${promotionId}:${triggerProductId ?? ''}`;
    const choiceMap: Record<string, any> = {};
    (dto.appliedPromotions ?? []).forEach((c) => {
      choiceMap[choiceKey(c.promotionId, c.triggerProductId)] = c;
    });
    const appliedIds =
      dto.appliedPromotions && dto.appliedPromotions.length > 0
        ? dto.appliedPromotions.map((c) => c.promotionId)
        : (dto.appliedPromotionIds ?? []);

    // Engine chạy trên dòng thường (không tính discounted_buy vào điều kiện mua-thưởng).
    // Chỉ hàng loại tồn 'normal' mới được hưởng/tính vào ngưỡng KM — hàng bục rách
    // (damaged) và cận date (near_expiry) LOẠI khỏi engine (không tính ngưỡng, không sinh quà).
    const engineItems = baseItems
      .filter(
        (it) =>
          it.lineType === 'normal' &&
          (it.conditionType || 'normal') === 'normal',
      )
      .map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        price: it.price,
        discount: it.discount,
        enabledPromotionIds: it.enabledPromotionIds,
      }));

    const evalResult = await this.promotionsService.evaluateForInvoice({
      branchId: dto.branchId,
      customerId: dto.customerId ?? null,
      userId: dto.soldById ?? null,
      purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : new Date(),
      items: engineItems,
      appliedPromotionIds: appliedIds,
    });

    const applied = (evalResult as any).applied as any[];
    let extraInvoiceDiscount = 0;
    const logs: any[] = [];

    // Resolve giftLines hiệu dụng cho từng KM (engine tự sinh hoặc theo lựa chọn thu ngân)
    const resolvedGifts: Record<string, any[]> = {};
    for (const r of applied) {
      const resultKey = choiceKey(r.promotionId, r.triggerProductId);
      let giftLines = r.giftLines as any[];
      // KM cần thu ngân chọn quà (nhóm Y nhiều SP)
      if (
        (r.type === 'BUY_X_GET_Y' || r.type === 'BUY_N_GET_M_SAME') &&
        r.requiresChoice
      ) {
        let choice =
          choiceMap[resultKey] || choiceMap[choiceKey(r.promotionId)];
        // Số quà mỗi suất = tổng SL / số suất (fallback = tổng SL nếu thiếu times).
        const perTime =
          r.rewardTimes && r.rewardTimes > 0
            ? Number(r.rewardQuantity) / Number(r.rewardTimes)
            : Number(r.rewardQuantity);

        // Tái dựng rewardSelections từ dòng quà FE gửi khi choice thiếu/rỗng.
        // Chỉ áp cho KM cộng dồn (triggerProductId==null) ở luồng createFromOrder.
        // Suy ngược số suất từ SL quà (gói) — mirror logic FE effect:
        //   carton: times = round(qtyGoi / perTime / conversionValue)
        //   unit:   times = round(qtyGoi / perTime)
        // resolveChoiceGiftLines vẫn re-validate tổng suất ≤ r.rewardTimes + cap remaining.
        const choiceHasSelections =
          choice &&
          Array.isArray(choice.rewardSelections) &&
          choice.rewardSelections.some((s: any) => Number(s.rewardTimes) > 0);
        if (
          opts?.reconstructCumulativeChoices &&
          r.triggerProductId == null &&
          !choiceHasSelections &&
          perTime > 0
        ) {
          const feGifts = feGiftQtyByPromoProduct.get(Number(r.promotionId));
          if (feGifts && feGifts.size > 0) {
            const isCarton = r.unitMode === 'carton';
            const rewardSelections: any[] = [];
            for (const [productId, qtyGoi] of feGifts) {
              const opt = (r.rewardOptions || []).find(
                (o: any) => o.productId === productId,
              );
              if (!opt) continue;
              const conv = Number(opt.conversionValue || 1) || 1;
              const times = isCarton
                ? Math.round(qtyGoi / perTime / conv)
                : Math.round(qtyGoi / perTime);
              if (times > 0)
                rewardSelections.push({ productId, rewardTimes: times });
            }
            if (rewardSelections.length > 0) choice = { rewardSelections };
          }
        }

        giftLines = this.resolveChoiceGiftLines(r, choice, perTime);
      }
      resolvedGifts[resultKey] = giftLines.map((g: any) => ({
        ...g,
        triggerProductId: r.triggerProductId,
      }));
    }

    // Lấy code/name + cost cho sản phẩm tặng
    const giftProductIds = Object.values(resolvedGifts)
      .flat()
      .map((g: any) => g.productId);
    const giftProducts = giftProductIds.length
      ? await tx.product.findMany({
          where: { id: { in: giftProductIds } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const giftProductMap: Record<number, any> = {};
    giftProducts.forEach((p) => (giftProductMap[p.id] = p));

    const giftCosts = giftProductIds.length
      ? await tx.inventory.findMany({
          where: { branchId: dto.branchId, productId: { in: giftProductIds } },
          select: { productId: true, cost: true },
        })
      : [];
    const costMap: Record<number, number> = {};
    giftCosts.forEach((c) => (costMap[c.productId] = Number(c.cost)));

    for (const r of applied) {
      const resultKey = choiceKey(r.promotionId, r.triggerProductId);
      // 1) Giảm giá hóa đơn
      // Defense-in-depth: nếu KM không autoApply và user chưa chọn → bỏ qua,
      // dù filter ở promotions.service có lọt thì đây vẫn chặn.
      if (r.type === 'INVOICE_DISCOUNT') {
        if (r.autoApply !== false || appliedIds.includes(r.promotionId)) {
          extraInvoiceDiscount += Number(r.discountAmount);
        }
      }

      // 2) Giảm giá dòng (PRODUCT/CATEGORY_DISCOUNT)
      for (const dl of r.discountLines) {
        const target = baseItems.find(
          (it) =>
            it.productId === dl.productId &&
            it.lineType === 'normal' &&
            (it.conditionType || 'normal') === 'normal',
        );
        if (target) {
          target.discount += Number(dl.perUnitDiscount);
          target.totalPrice =
            (target.price - target.discount) * target.quantity;
          target.lineType = 'promo_discount';
          target.promotionId = r.promotionId;
        }
      }

      // 2b) Gắn promotionId lên dòng X (hàng mua điều kiện) để thống kê.
      // GIỮ lineType='normal' — đây là hàng bán giá thường, KHÔNG phải hàng KM.
      const matchedIds: number[] = r.triggerProductId
        ? [r.triggerProductId]
        : r.matchedProductIds || [];
      if (matchedIds.length) {
        for (const it of baseItems) {
          if (
            it.lineType === 'normal' &&
            (it.conditionType || 'normal') === 'normal' &&
            it.promotionId == null &&
            matchedIds.includes(it.productId)
          ) {
            it.promotionId = r.promotionId;
          }
        }
      }

      // 3) Hàng tặng (BE tự sinh dòng giá 0). Cho phép tồn âm (chỉ cảnh báo ở FE).
      const giftLines = resolvedGifts[resultKey] || [];
      for (const g of giftLines) {
        const p = giftProductMap[g.productId];
        baseItems.push({
          productId: g.productId,
          productCode: p?.code || '',
          productName: p?.name || g.productName || '',
          quantity: Number(g.quantity),
          price: 0,
          discount: 0,
          discountRatio: 0,
          totalPrice: 0,
          note: undefined,
          conditionType: 'normal',
          lineType: 'gift',
          isGift: true,
          promotionId: r.promotionId,
          triggerProductId: r.triggerProductId,
          enabledPromotionIds: undefined,
        });
      }

      // 4) Validate dòng mua kèm giá KM (discounted_buy) do FE gửi.
      //    Với KM requiresChoice, rewardOptions là tập SP hợp lệ; nếu không thì 1 SP cố định.
      const allowedBuyIds: number[] =
        r.requiresChoice && r.type === 'BUY_X_BUY_Y_PRICE'
          ? (r.rewardOptions || []).map((o: any) => o.productId)
          : (r.discountedBuyLines || []).map((d: any) => d.productId);
      const baseBuyQty =
        r.rewardQuantity != null
          ? Number(r.rewardQuantity)
          : (r.discountedBuyLines?.[0]?.maxQuantity ?? 0);
      const isCartonBuy = r.unitMode === 'carton';
      for (const feLine of baseItems.filter(
        (it) =>
          it.lineType === 'discounted_buy' &&
          it.promotionId === r.promotionId &&
          (it.triggerProductId == null ||
            it.triggerProductId === r.triggerProductId),
      )) {
        if (!allowedBuyIds.includes(feLine.productId)) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: sản phẩm mua kèm "${feLine.productName}" không thuộc chương trình "${r.name}"`,
          );
        }
        // Cap theo suất còn lại (lifetime) của đúng SP mua kèm được chọn.
        const opt = (r.rewardOptions || []).find(
          (o: any) => o.productId === feLine.productId,
        );
        let maxBuyQty = baseBuyQty; // đơn vị CT (gói/thùng)
        if (opt?.remaining != null) {
          maxBuyQty = Math.min(maxBuyQty, Number(opt.remaining));
        }
        // carton: quy maxBuyQty (thùng) → gói theo conversionValue của SP mua kèm.
        if (isCartonBuy) {
          maxBuyQty = Math.round(maxBuyQty * Number(opt?.conversionValue || 1));
        }
        if (maxBuyQty && feLine.quantity > maxBuyQty) {
          throw new BadRequestException(
            `PROMOTION_CHANGED: số lượng mua kèm "${feLine.productName}" vượt mức cho phép (${maxBuyQty})`,
          );
        }
      }

      const giftValue = giftLines.reduce(
        (s: number, g: any) =>
          s + (costMap[g.productId] || 0) * Number(g.quantity),
        0,
      );
      logs.push({
        promotionId: r.promotionId,
        promotionCode: r.code,
        promotionName: r.name,
        type: r.type,
        discountAmount: Number(r.discountAmount),
        giftValue,
        rewardSnapshot: {
          giftLines,
          discountLines: r.discountLines,
          discountedBuyLines: r.discountedBuyLines,
          rewardOptions: r.rewardOptions,
        },
        status: 'applied',
      });
    }

    // Chèn gift / discounted_buy ngay sau đúng SP X kích hoạt.
    // mirror FE giỏ hàng. Không có reward → thứ tự giữ nguyên.
    const isRewardLine = (it: any) => {
      const lt = it.lineType || 'normal';
      return lt === 'gift' || lt === 'discounted_buy' || !!it.isGift;
    };
    const normals = baseItems.filter((it) => !isRewardLine(it));
    const rewards = baseItems.filter((it) => isRewardLine(it));
    if (rewards.length > 0) {
      const used = new Set<any>();
      const reordered: any[] = [];
      for (const n of normals) {
        reordered.push(n);
        if (n.promotionId != null) {
          for (const r of rewards) {
            if (
              !used.has(r) &&
              r.promotionId === n.promotionId &&
              (r.triggerProductId == null || r.triggerProductId === n.productId)
            ) {
              reordered.push(r);
              used.add(r);
            }
          }
        }
      }
      for (const r of rewards) {
        if (!used.has(r)) reordered.push(r);
      }
      baseItems.length = 0;
      baseItems.push(...reordered);
    }

    return { effectiveItems: baseItems, extraInvoiceDiscount, logs };
  }

  async create(dto: CreateInvoiceDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const code = await this.generateSafeInvoiceCode(tx);

        const promo = await this.processPromotions(tx, dto);
        const effectiveItems = await this.markPromoStockDeductionItems(
          tx,
          promo.effectiveItems,
        );

        const totalAmount = effectiveItems.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        // Giảm giá hiệu dụng: ưu tiên số tiền đã chốt (discountAmount).
        // discountRatio chỉ là metadata (% tương ứng) — nếu chỉ có ratio (data cũ)
        // thì quy đổi sang tiền. Tránh trừ 2 lần khi lưu cả hai.
        const discountAmount =
          dto.discountAmount && dto.discountAmount > 0
            ? dto.discountAmount + promo.extraInvoiceDiscount
            : (totalAmount * (dto.discountRatio || 0)) / 100 +
              promo.extraInvoiceDiscount;
        const grandTotal = totalAmount - discountAmount;
        const paidAmount = dto.paidAmount || 0;
        const debtAmount = grandTotal - paidAmount;

        const status: number = INVOICE_STATUS.PROCESSING;
        // Hóa đơn mới luôn bắt đầu ở PROCESSING — không tự chuyển COMPLETED dù đã thanh toán đủ,
        // vì chưa giao hàng. COMPLETED chỉ áp dụng khi đã DELIVERED + thanh toán đủ.

        const customer = dto.customerId
          ? await tx.customer.findUnique({
              where: { id: dto.customerId },
              select: { id: true, totalDebt: true, name: true },
            })
          : null;

        const parentCustomerId = customer ? customer.id : null;

        const currentCustomerDebt = Number(customer?.totalDebt || 0);
        const customerDebtSnapshot = currentCustomerDebt + debtAmount;

        let priceBook: any = null;

        if (dto.priceBookId && dto.priceBookId > 0) {
          priceBook = await tx.priceBook.findFirst({
            where: { id: dto.priceBookId, isActive: true },
          });
        } else if (dto.priceBookId === undefined || dto.priceBookId === null) {
          const applicablePriceBooks = await tx.priceBook.findMany({
            where: {
              isActive: true,
              OR: [
                { isGlobal: true },
                { priceBookBranches: { some: { branchId: dto.branchId } } },
                ...(dto.customerId
                  ? [
                      {
                        priceBookCustomerGroups: {
                          some: {
                            customerGroup: {
                              customerGroupDetails: {
                                some: { customerId: dto.customerId },
                              },
                            },
                          },
                        },
                      },
                      { forAllCusGroup: true },
                    ]
                  : []),
              ],
            },
            orderBy: { priority: 'desc' },
            take: 1,
          });
          priceBook = applicablePriceBooks[0] || null;
        }
        // dto.priceBookId === 0 → "Bảng giá chung" → priceBook giữ null

        // Snapshot địa chỉ cũ (3 cấp) + mới (2 cấp) từ customer_addresses để shipper xem cả hai.
        const invoiceAddrSnapshot = await resolveDeliveryAddress(
          tx,
          dto.customerId,
        );

        const invoice = await tx.invoice.create({
          data: {
            code,
            customerId: dto.customerId,
            parentCustomerId,
            branchId: dto.branchId,
            soldById: dto.soldById,
            saleChannelId: dto.saleChannelId,
            priceBookId: priceBook?.id || null,
            priceBookName: priceBook?.name || null,
            purchaseDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : new Date(),
            totalAmount,
            discount: discountAmount,
            discountRatio: dto.discountRatio || 0,
            grandTotal,
            paidAmount,
            debtAmount,
            status,
            statusValue: getStatusLabel(status),
            usingCod: dto.usingCod || false,
            description: dto.description,
            createdBy: userId,
            customerDebtSnapshot,
            details: {
              createMany: {
                data: effectiveItems.map((item) => ({
                  productId: item.productId,
                  productCode: item.productCode,
                  productName: item.productName,
                  quantity: item.quantity,
                  price: item.price,
                  discount: item.discount || 0,
                  discountRatio: item.discountRatio || 0,
                  totalPrice: item.totalPrice,
                  note: item.note,
                  conditionType: item.conditionType || 'normal',
                  soldExpiryDate: item.soldExpiryDate
                    ? new Date(item.soldExpiryDate)
                    : null,
                  lineType: item.lineType || 'normal',
                  isGift: item.isGift || false,
                  promotionId: item.promotionId ?? null,
                })),
              },
            },
            ...(dto.delivery && {
              delivery: {
                create: {
                  receiver: dto.delivery.receiver,
                  contactNumber: dto.delivery.contactNumber,
                  address: dto.delivery.address,
                  locationName: dto.delivery.locationName,
                  wardName: dto.delivery.wardName,
                  oldCityName: invoiceAddrSnapshot.oldCityName,
                  oldDistrictName: invoiceAddrSnapshot.oldDistrictName,
                  oldWardName: invoiceAddrSnapshot.oldWardName,
                  newCityName: invoiceAddrSnapshot.newCityName,
                  newWardName: invoiceAddrSnapshot.newWardName,
                  weight: dto.delivery.weight,
                  weightUnit: dto.delivery.weightUnit || 'g',
                  length: dto.delivery.length,
                  width: dto.delivery.width,
                  height: dto.delivery.height,
                  noteForDriver: dto.delivery.noteForDriver,
                },
              },
            }),
          },
          include: {
            details: true,
            payments: true,
            delivery: true,
          },
        });

        if (paidAmount > 0) {
          if (!dto.branchId) {
            throw new Error('Vui lòng chọn chi nhánh');
          }

          const paymentCustomer = dto.customerId
            ? await tx.customer.findUnique({
                where: { id: dto.customerId },
                select: { id: true, name: true },
              })
            : null;

          // Tách thành từng phương thức thanh toán. Nếu FE không gửi mảng
          // payments (data cũ) thì fallback về 1 phiếu thu tiền mặt.
          const paymentItems =
            dto.payments && dto.payments.length > 0
              ? dto.payments
              : [{ method: 'cash', amount: paidAmount, accountId: undefined }];

          const existingPayments = await tx.invoicePayment.findMany({
            where: { invoiceId: invoice.id },
          });
          let paymentSequence = existingPayments.length;
          let cumulativePaid = 0;

          for (const item of paymentItems) {
            paymentSequence += 1;
            const paymentCode = `TT${invoice.code}-${paymentSequence}`;
            const method = item.method || 'cash';

            await tx.invoicePayment.create({
              data: {
                code: paymentCode,
                invoiceId: invoice.id,
                status: 1,
                statusValue: 'Paid',
                amount: item.amount,
                paymentDate: new Date(),
                paymentMethod: method,
                accountId: item.accountId,
                description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
              },
            });

            cumulativePaid += Number(item.amount);

            await tx.cashFlow.create({
              data: {
                code: paymentCode,
                branchId: dto.branchId,
                cashFlowGroupId: 3,
                isReceipt: true,
                amount: item.amount,
                transDate: new Date(),
                method,
                accountId: item.accountId,
                partnerType: 'C',
                partnerId: invoice.customerId,
                partnerName: paymentCustomer?.name,
                description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
                status: 0,
                statusValue: 'Đã thanh toán',
                createdBy: userId,
                usedForFinancialReporting: 1,
                customerDebtSnapshot:
                  currentCustomerDebt + grandTotal - cumulativePaid,
              },
            });
          }
        }

        const branch = await tx.branch.findUnique({
          where: { id: dto.branchId },
          select: { id: true, name: true },
        });

        // Fetch người thực hiện sớm để ghi userId/createdByName vào InventoryLog
        // (truy vết trách nhiệm trên thẻ kho). Trước đây chỉ fetch sau vòng lặp
        // xuất kho → InventoryLog không lưu được ai xuất.
        const actorUser = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        const logActor = buildInventoryLogActor(
          userId,
          actorUser?.name || actorUser?.email,
        );

        for (const item of effectiveItems) {
          const condition = item.conditionType || 'normal';
          const invSnapshot = await tx.inventory.findFirst({
            where: { productId: item.productId, branchId: dto.branchId },
          });

          await this.validateConditionQuantity(
            tx,
            item.productId,
            dto.branchId!,
            item.quantity,
            condition,
            item.soldExpiryDate,
          );

          await tx.inventory.updateMany({
            where: { productId: item.productId, branchId: dto.branchId },
            data: this.buildInventoryDeductData(item.quantity, condition, {
              isGift: !!(item.isGift || item.lineType === 'gift'),
              deductPromoStock: !!item.deductPromoStock,
            }),
          });
          touchedProductIds.add(item.productId);

          await tx.inventoryLog.create({
            data: {
              productId: item.productId,
              productCode: item.productCode || '',
              productName: item.productName || '',
              branchId: dto.branchId!,
              branchName: branch?.name || '',
              transactionType: 'SALE',
              refCode: invoice.code,
              refType: 'invoice',
              refId: invoice.id,
              quantity: -Number(item.quantity),
              costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
              transactionPrice: Number(item.price),
              partnerId: dto.customerId || null,
              partnerName: customer?.name,
              // Thẻ kho phải lấy theo "Thời gian" (purchaseDate) của hóa đơn,
              // KHÔNG theo "Thời gian tạo" (createdAt). Đồng nhất với nhánh
              // sửa hóa đơn (.xx) và khớp ý thiết kế schema (transactionDate
              // là ngày phát sinh giao dịch, hỗ trợ lùi ngày khi backdate).
              transactionDate: invoice.purchaseDate,
              ...buildInventoryLogBase(logActor),
            },
          });

          // Sổ cái loại tồn: trừ bucket (damaged/near_expiry/PROMO) khi bán.
          await this.writeSaleConditionLog(tx, {
            item,
            branchId: dto.branchId!,
            branchName: branch?.name || '',
            invoiceCode: invoice.code,
            invoiceId: invoice.id,
            transactionDate: invoice.purchaseDate,
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
          });
        }

        // Recalc cache bucket từ sổ cái cho mọi sản phẩm vừa bán.
        await recalcConditionBucketsForPairs(
          tx,
          effectiveItems.map((item) => ({
            productId: item.productId,
            branchId: dto.branchId!,
          })),
        );

        // Ghi log khuyến mãi đã áp + tăng usageCount
        if (promo.logs.length > 0) {
          await tx.invoicePromotionLog.createMany({
            data: promo.logs.map((l) => ({ ...l, invoiceId: invoice.id })),
          });
          await tx.promotion.updateMany({
            where: { id: { in: promo.logs.map((l) => l.promotionId) } },
            data: { usageCount: { increment: 1 } },
          });
        }

        // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi đã ghi log SALE cho
        // mọi item, recalc lại onHand từ thẻ kho (đè giá trị decrement rời rạc).
        await recalcOnHandForPairs(
          tx,
          effectiveItems.map((item) => ({
            productId: item.productId,
            branchId: dto.branchId!,
          })),
        );

        if (dto.customerId) {
          await this.updateCustomerTotals(dto.customerId, tx);
        }

        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        const orderCode = await tx.order.findUnique({
          where: { id: Number(invoice.orderId) },
          select: { code: true },
        });

        const customerName = await tx.customer.findUnique({
          where: { id: Number(invoice.customerId) },
          select: { name: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'INVOICE_CREATE',
          entityType: 'invoices',
          entityId: invoice.id.toString(),
          entityCode: invoice.code,
          category: getCategoryFromActionCode('INVOICE_CREATE'),
          severity: getSeverityFromActionCode('INVOICE_CREATE'),
          snapshot: this.buildInvoiceSnapshot(invoice),
          message: renderAuditMessage('INVOICE_CREATE', {
            invoiceCode: invoice.code,
            orderCode: orderCode || '',
            customerName: customerName || '',
          }),
          messageTemplate: 'INVOICE_CREATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: invoice.branchId || undefined,
        });

        return tx.invoice.findUnique({
          where: { id: invoice.id },
          include: {
            details: true,
            payments: true,
            delivery: true,
            customer: true,
            branch: true,
            soldBy: true,
            priceBook: true,
          },
        });
      },
      { timeout: 30000 },
    );

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async update(id: number, dto: UpdateInvoiceDto, userId?: number) {
    await this.findOne(id);

    // Danh sách packing slip (giao-hang) bị ảnh hưởng bởi versioning để gửi lại Zalo
    // sau khi transaction commit (fire-and-forget).
    let affectedPackingSlipIds: number[] = [];
    const touchedProductIds = new Set<number>();

    const result = await this.prisma.$transaction(async (tx) => {
      const currentInvoice = await tx.invoice.findUnique({
        where: { id },
        include: {
          details: true,
          customer: { select: { totalDebt: true, code: true, name: true } },
          payments: true,
          delivery: true,
          branch: true,
          soldBy: true,
          order: true,
        },
      });

      if (!currentInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      if (dto.items && this.hasVersionableChanges(currentInvoice, dto)) {
        const newCode = await this.generateInvoiceCodeWithSuffix(
          currentInvoice.code,
          tx,
        );

        const { cancelLog, newLog } = this.buildProductChangesLog(
          currentInvoice.details,
          dto.items,
        );

        const userName = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });

        // Actor cho InventoryLog nhánh versioning (.xx). userId optional →
        // guard tránh truyền undefined. Truy vết ai xuất kho cho hóa đơn sửa.
        const versioningLogActor = buildInventoryLogActor(
          userId,
          userName?.name,
        );

        await this.auditLogsService.create({
          actionType: 'DELETE',
          actionCode: 'INVOICE_CANCEL',
          entityType: 'invoices',
          entityId: String(currentInvoice.id),
          entityCode: currentInvoice.code,
          category: getCategoryFromActionCode('INVOICE_CANCEL'),
          severity: getSeverityFromActionCode('INVOICE_CANCEL'),
          snapshot: this.buildInvoiceSnapshot(currentInvoice),
          message: renderAuditMessage('INVOICE_CANCEL', {
            invoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_CANCEL',
          userId: userId || currentInvoice.createdBy,
          userName: userName?.name || 'System',
          branchId: currentInvoice.branchId || undefined,
        });

        for (const oldDetail of currentInvoice.details) {
          await tx.inventory.updateMany({
            where: {
              ...(oldDetail.productId != null && {
                productId: oldDetail.productId,
              }),
              branchId: currentInvoice.branchId || 1,
            },
            data: this.buildInventoryRestoreData(
              Number(oldDetail.quantity),
              (oldDetail as any).conditionType || 'normal',
              {
                isGift: !!(
                  (oldDetail as any).isGift ||
                  (oldDetail as any).lineType === 'gift'
                ),
              },
            ),
          });
          if (oldDetail.productId != null)
            touchedProductIds.add(oldDetail.productId);
        }

        // Auto-cancel CTN gắn HĐ cũ (đồng bộ với D6 block trong CANCEL flow)
        const linkedCtns = await tx.returnOrder.findMany({
          where: {
            invoiceId: id,
            refundType: 'manual_offset',
            status: 4,
          },
          select: { id: true },
        });

        if (linkedCtns.length > 0) {
          await tx.returnOrder.updateMany({
            where: { id: { in: linkedCtns.map((c) => c.id) } },
            data: { status: 5, statusValue: 'Đã hủy' },
          });
        }

        await tx.invoice.update({
          where: { id },
          data: {
            status: INVOICE_STATUS.CANCELLED,
            statusValue: 'Đã hủy',
            paidAmount: 0,
            debtAmount: 0,
          },
        });

        // Revert log KM của HĐ cũ (tránh lệch usageCount khi tạo HĐ mới .xx).
        // Bao gồm cả log orderId=null (HĐ bán thẳng) và log orderId!=null (HĐ từ
        // đơn đã "tiếp quản" tracking). Log reverted giữ lại để audit.
        const oldPromoLogs = await tx.invoicePromotionLog.findMany({
          where: { invoiceId: id, status: 'applied' },
          select: { id: true, promotionId: true },
        });
        if (oldPromoLogs.length > 0) {
          for (const lg of oldPromoLogs) {
            await tx.promotion.updateMany({
              where: { id: lg.promotionId },
              data: { usageCount: { decrement: 1 } },
            });
          }
          await tx.invoicePromotionLog.updateMany({
            where: { id: { in: oldPromoLogs.map((l) => l.id) } },
            data: { status: 'reverted' },
          });
        }

        // Chạy engine KM để re-validate + sinh lại dòng quà authoritatively
        // (kể cả KM cộng dồn rewardSelections). skipPromotions === true → giữ
        // dto.items nguyên, không chạy engine.
        let effectiveItems: any[] = dto.items as any[];
        let extraInvoiceDiscount = 0;
        let promoLogs: any[] = [];
        if (dto.skipPromotions !== true) {
          const promo = await this.processPromotions(tx, dto as any);
          effectiveItems = promo.effectiveItems;
          extraInvoiceDiscount = promo.extraInvoiceDiscount;
          promoLogs = promo.logs;
        }
        effectiveItems = await this.markPromoStockDeductionItems(
          tx,
          effectiveItems,
        );

        const totalAmount = effectiveItems.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        const discountAmount =
          dto.discountAmount && dto.discountAmount > 0
            ? dto.discountAmount + extraInvoiceDiscount
            : (totalAmount * (dto.discountRatio || 0)) / 100 +
              extraInvoiceDiscount;
        const grandTotal = totalAmount - discountAmount;
        // Chỉ cộng các payment còn active (loại đã hủy) — payments sẽ được transfer sang HĐ mới
        const activePayments = currentInvoice.payments.filter(
          (p: any) => p.status !== 2,
        );
        const paidAmount = activePayments.reduce(
          (sum: number, p: any) => sum + Number(p.amount),
          0,
        );
        const debtAmount = grandTotal - paidAmount;

        // Hóa đơn mới (.xx) kế thừa nguyên trạng thái của hóa đơn cũ
        // (processing → processing, packed → packed, loading → loading,
        // delivered → delivered) để báo đơn nhất quán.
        // Hai ngoại lệ:
        // - COMPLETED: phụ thuộc thanh toán đã tính lại — còn nợ thì lùi về
        //   DELIVERED, hết nợ thì giữ COMPLETED.
        // - CANCELLED: hóa đơn mới không thể mang trạng thái "đã hủy" → PROCESSING.
        let status: number;
        if (currentInvoice.status === INVOICE_STATUS.COMPLETED) {
          status =
            debtAmount <= 0
              ? INVOICE_STATUS.COMPLETED
              : INVOICE_STATUS.DELIVERED;
        } else if (currentInvoice.status === INVOICE_STATUS.CANCELLED) {
          status = INVOICE_STATUS.PROCESSING;
        } else {
          status = currentInvoice.status;
        }

        const customerDebtSnapshot = currentInvoice.customer
          ? Number(currentInvoice.customer.totalDebt) -
            Number(currentInvoice.debtAmount) +
            debtAmount
          : null;

        const cancelCustomerId = dto.customerId ?? currentInvoice.customerId;
        const cancelParentCustomerId = cancelCustomerId;

        // Xác định priceBook cho hóa đơn mới
        let newPriceBookId = currentInvoice.priceBookId;
        let newPriceBookName = currentInvoice.priceBookName;

        if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
          if (dto.priceBookId > 0) {
            const priceBook = await tx.priceBook.findFirst({
              where: { id: dto.priceBookId, isActive: true },
            });
            newPriceBookId = priceBook?.id || null;
            newPriceBookName = priceBook?.name || null;
          } else {
            // dto.priceBookId === 0 → "Bảng giá chung"
            newPriceBookId = null;
            newPriceBookName = null;
          }
        }

        // Snapshot địa chỉ cũ+mới: resolve lại theo customerId mới (nếu đổi khách) hoặc giữ snapshot cũ.
        const updateCustomerId = dto.customerId ?? currentInvoice.customerId;
        const updateAddrSnapshot = dto.delivery
          ? await resolveDeliveryAddress(tx, updateCustomerId)
          : null;

        const newInvoice = await tx.invoice.create({
          data: {
            code: newCode,
            orderId: currentInvoice.orderId,
            customerId: dto.customerId ?? currentInvoice.customerId,
            parentCustomerId: cancelParentCustomerId,
            branchId: dto.branchId ?? currentInvoice.branchId,
            soldById: dto.soldById ?? currentInvoice.soldById,
            saleChannelId: currentInvoice.saleChannelId,
            priceBookId: newPriceBookId,
            priceBookName: newPriceBookName,
            // Hóa đơn con (.xx) là bản sửa của hóa đơn gốc → luôn kế thừa
            // purchaseDate ("Thời gian") của hóa đơn gốc, bỏ qua dto.purchaseDate
            // (frontend luôn gửi thời điểm lưu hiện tại). createdAt vẫn là thời
            // điểm tạo thật của hóa đơn con (cột "Thời gian tạo").
            purchaseDate: currentInvoice.purchaseDate,
            totalAmount,
            discount: discountAmount,
            discountRatio: dto.discountRatio || 0,
            grandTotal,
            paidAmount,
            debtAmount,
            status,
            statusValue: getStatusLabel(status),
            customerDebtSnapshot,
            usingCod: currentInvoice.usingCod,
            description: dto.description ?? currentInvoice.description,
            createdBy: currentInvoice.createdBy,
            details: {
              create: effectiveItems.map((item) => ({
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                discount: item.discount || 0,
                discountRatio: item.discountRatio || 0,
                totalPrice: item.totalPrice,
                note: item.note,
                conditionType: item.conditionType || 'normal',
                soldExpiryDate: item.soldExpiryDate
                  ? new Date(item.soldExpiryDate)
                  : null,
                lineType: item.lineType || 'normal',
                isGift: item.isGift || false,
                promotionId: item.promotionId ?? null,
              })),
            },
            ...(dto.delivery
              ? {
                  delivery: {
                    create: {
                      receiver: dto.delivery.receiver,
                      contactNumber: dto.delivery.contactNumber,
                      address: dto.delivery.address,
                      locationName: dto.delivery.locationName,
                      wardName: dto.delivery.wardName,
                      oldCityName: updateAddrSnapshot?.oldCityName ?? null,
                      oldDistrictName:
                        updateAddrSnapshot?.oldDistrictName ?? null,
                      oldWardName: updateAddrSnapshot?.oldWardName ?? null,
                      newCityName: updateAddrSnapshot?.newCityName ?? null,
                      newWardName: updateAddrSnapshot?.newWardName ?? null,
                      weight: dto.delivery.weight,
                      weightUnit: dto.delivery.weightUnit || 'g',
                      length: dto.delivery.length,
                      width: dto.delivery.width,
                      height: dto.delivery.height,
                      noteForDriver: dto.delivery.noteForDriver,
                      status: 1,
                      statusValue: 'Chờ xử lý',
                    },
                  },
                }
              : currentInvoice.delivery
                ? {
                    delivery: {
                      create: {
                        receiver: currentInvoice.delivery.receiver,
                        contactNumber: currentInvoice.delivery.contactNumber,
                        address: currentInvoice.delivery.address,
                        locationName: currentInvoice.delivery.locationName,
                        wardName: currentInvoice.delivery.wardName,
                        oldCityName: currentInvoice.delivery.oldCityName,
                        oldDistrictName:
                          currentInvoice.delivery.oldDistrictName,
                        oldWardName: currentInvoice.delivery.oldWardName,
                        newCityName: currentInvoice.delivery.newCityName,
                        newWardName: currentInvoice.delivery.newWardName,
                        weight: currentInvoice.delivery.weight,
                        weightUnit: currentInvoice.delivery.weightUnit || 'g',
                        length: currentInvoice.delivery.length,
                        width: currentInvoice.delivery.width,
                        height: currentInvoice.delivery.height,
                        noteForDriver: currentInvoice.delivery.noteForDriver,
                        status: currentInvoice.delivery.status,
                        statusValue: currentInvoice.delivery.statusValue,
                      },
                    },
                  }
                : {}),
          },
          include: {
            details: true,
            delivery: true,
            customer: true,
            order: true,
            branch: true,
            soldBy: true,
            priceBook: true,
          },
        });

        // Repoint các phiếu báo đơn (giao hàng / đóng hàng / loading) đang trỏ
        // tới hóa đơn cũ (vừa bị hủy) sang hóa đơn mới (.01). Vì newInvoice.id là
        // id hoàn toàn mới nên không vi phạm @@unique([packingXId, invoiceId]).
        const affectedSlipRows = await tx.packingSlipInvoice.findMany({
          where: { invoiceId: id },
          select: { packingSlipId: true },
        });
        affectedPackingSlipIds = affectedSlipRows.map((r) => r.packingSlipId);

        await tx.packingSlipInvoice.updateMany({
          where: { invoiceId: id },
          data: { invoiceId: newInvoice.id },
        });
        await tx.packingHangInvoice.updateMany({
          where: { invoiceId: id },
          data: { invoiceId: newInvoice.id },
        });
        await tx.packingLoadingInvoice.updateMany({
          where: { invoiceId: id },
          data: { invoiceId: newInvoice.id },
        });

        for (const payment of currentInvoice.payments) {
          await tx.invoicePayment.update({
            where: { id: payment.id },
            data: {
              invoiceId: newInvoice.id,
              description: `${payment.description || 'Thanh toán hóa đơn'} (Chuyển từ ${currentInvoice.code} sang ${newCode})`,
            },
          });
        }

        for (const item of effectiveItems) {
          const invSnapshot = await tx.inventory.findFirst({
            where: {
              productId: item.productId,
              branchId: newInvoice.branchId || 1,
            },
          });

          const condition = item.conditionType || 'normal';
          await this.validateConditionQuantity(
            tx,
            item.productId,
            newInvoice.branchId || 1,
            item.quantity,
            condition,
            item.soldExpiryDate,
          );
          await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              branchId: newInvoice.branchId || 1,
            },
            data: this.buildInventoryDeductData(item.quantity, condition, {
              isGift: !!(item.isGift || item.lineType === 'gift'),
              deductPromoStock: !!item.deductPromoStock,
            }),
          });
          touchedProductIds.add(item.productId);

          await tx.inventoryLog.create({
            data: {
              productId: item.productId,
              productCode: item.productCode || '',
              productName: item.productName || '',
              branchId: newInvoice.branchId || 1,
              branchName: newInvoice.branch?.name || '',
              transactionType: 'SALE',
              refCode: newInvoice.code,
              refType: 'invoice',
              refId: newInvoice.id,
              quantity: -Number(item.quantity),
              costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
              transactionPrice: Number(item.price),
              partnerId: newInvoice.customerId || null,
              partnerName: newInvoice.customer?.name || null,
              // Thẻ kho phải lấy theo "Thời gian" (purchaseDate) của hóa đơn,
              // KHÔNG theo "Thời gian tạo" (createdAt). Hóa đơn .xx kế thừa
              // purchaseDate của hóa đơn gốc (dòng 1788) → transactionDate cũng
              // phải kế thừa tương ứng, nếu không thẻ kho sẽ nhảy về thời điểm
              // sửa (= createdAt) thay vì ngày bán gốc.
              transactionDate: newInvoice.purchaseDate,
              ...buildInventoryLogBase(versioningLogActor),
            },
          });

          // Sổ cái loại tồn cho HĐ .xx.
          await this.writeSaleConditionLog(tx, {
            item,
            branchId: newInvoice.branchId || 1,
            branchName: newInvoice.branch?.name || '',
            invoiceCode: newInvoice.code,
            invoiceId: newInvoice.id,
            transactionDate: newInvoice.purchaseDate,
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
          });
        }

        // Ghi log KM mới + tăng usageCount cho HĐ .xx.
        if (promoLogs.length > 0) {
          await tx.invoicePromotionLog.createMany({
            data: promoLogs.map((l) => ({ ...l, invoiceId: newInvoice.id })),
          });
          await tx.promotion.updateMany({
            where: { id: { in: promoLogs.map((l) => l.promotionId) } },
            data: { usageCount: { increment: 1 } },
          });
        }

        // NGUỒN CHÂN LÝ: recalc onHand cho mọi sản phẩm bị ảnh hưởng (hoàn kho
        // HĐ cũ đã hủy + trừ kho HĐ mới). Σ log active tự loại log HĐ cũ
        // (status=2) và cộng log HĐ mới.
        await recalcOnHandForPairs(tx, [
          ...currentInvoice.details.map((d) => ({
            productId: d.productId,
            branchId: currentInvoice.branchId || 1,
          })),
          ...effectiveItems.map((item) => ({
            productId: item.productId,
            branchId: newInvoice.branchId || 1,
          })),
        ]);

        // Recalc cache bucket từ sổ cái (HĐ cũ hủy + HĐ .xx mới).
        await recalcConditionBucketsForPairs(tx, [
          ...currentInvoice.details.map((d) => ({
            productId: d.productId,
            branchId: currentInvoice.branchId || 1,
          })),
          ...effectiveItems.map((item) => ({
            productId: item.productId,
            branchId: newInvoice.branchId || 1,
          })),
        ]);

        if (newInvoice.customerId) {
          await this.updateCustomerTotals(newInvoice.customerId, tx);
        }

        if (currentInvoice.orderId) {
          await this.ordersService['updateOrderStatusByInvoices'](
            currentInvoice.orderId,
            tx,
          );
        }

        const deliveryInfo = dto.delivery || currentInvoice.delivery;
        const deliveryLog = deliveryInfo
          ? `\nThông tin giao hàng:\n- Người nhận: ${deliveryInfo.receiver || ''}\n- Phí giao hàng: ${'price' in deliveryInfo ? deliveryInfo.price || 0 : 0}\n- Thu hộ tiền hàng: ${deliveryInfo.noteForDriver ? 'Có' : 'Không'}\n- Trạng thái giao: Chờ xử lý`
          : '';

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'INVOICE_CREATE_FROM_CANCELLED',
          entityType: 'invoices',
          entityId: String(newInvoice.id),
          entityCode: newCode,
          category: getCategoryFromActionCode('INVOICE_CREATE_FROM_CANCELLED'),
          severity: getSeverityFromActionCode('INVOICE_CREATE_FROM_CANCELLED'),
          snapshot: this.buildInvoiceSnapshot(newInvoice),
          message: renderAuditMessage('INVOICE_CREATE_FROM_CANCELLED', {
            invoiceCode: newCode,
            oldInvoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_CREATE_FROM_CANCELLED',
          userId: userId || currentInvoice.createdBy,
          userName: userName?.name || 'System',
          branchId: newInvoice.branchId || undefined,
        });

        return tx.invoice.findUnique({
          where: { id: newInvoice.id },
          include: {
            details: true,
            payments: true,
            delivery: true,
            customer: true,
            branch: true,
            soldBy: true,
            order: true,
            priceBook: true,
          },
        });
      }

      const updateData: any = {};

      if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
      if (dto.branchId !== undefined) updateData.branchId = dto.branchId;
      if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
      if (dto.description !== undefined)
        updateData.description = dto.description;

      let shouldUpdateCustomerDebt = false;

      if (dto.status !== undefined) {
        if (
          dto.status === INVOICE_STATUS.CANCELLED &&
          currentInvoice.status !== INVOICE_STATUS.CANCELLED
        ) {
          if (currentInvoice.status === INVOICE_STATUS.COMPLETED) {
            const actor = userId
              ? await tx.user.findUnique({
                  where: { id: userId },
                  include: { userRoles: { include: { role: true } } },
                })
              : null;
            const isAdmin = actor?.userRoles?.some(
              (ur: any) =>
                ur.role.name === 'Admin' || ur.role.name === 'Super Admin',
            );
            if (!isAdmin) {
              throw new ForbiddenException(
                'Chỉ Admin mới được phép hủy hóa đơn hoàn thành',
              );
            }
          }

          if (!currentInvoice.branchId) {
            throw new BadRequestException(
              'Không thể hủy hóa đơn vì không có thông tin chi nhánh',
            );
          }

          for (const detail of currentInvoice.details) {
            await tx.inventory.updateMany({
              where: {
                ...(detail.productId != null && {
                  productId: detail.productId,
                }),
                branchId: currentInvoice.branchId,
              },
              data: this.buildInventoryRestoreData(
                Number(detail.quantity),
                (detail as any).conditionType || 'normal',
                {
                  isGift: !!(
                    (detail as any).isGift ||
                    (detail as any).lineType === 'gift'
                  ),
                },
              ),
            });
            if (detail.productId != null)
              touchedProductIds.add(detail.productId);
          }

          // Hoàn khuyến mãi: chỉ áp cho hóa đơn bán thẳng (orderId = null).
          // Hóa đơn tạo từ đơn hàng kế thừa KM của đơn — usageCount/log thuộc về order,
          // sẽ được hoàn khi hủy chính đơn hàng đó.
          const revertLogs = await tx.invoicePromotionLog.findMany({
            where: { invoiceId: id, orderId: null, status: 'applied' },
            select: { promotionId: true },
          });
          if (revertLogs.length > 0) {
            for (const lg of revertLogs) {
              await tx.promotion.updateMany({
                where: { id: lg.promotionId },
                data: { usageCount: { decrement: 1 } },
              });
            }
            await tx.invoicePromotionLog.updateMany({
              where: { invoiceId: id, orderId: null, status: 'applied' },
              data: { status: 'reverted' },
            });
          }

          const linkedCtns = await tx.returnOrder.findMany({
            where: {
              invoiceId: id,
              refundType: 'manual_offset',
              status: 4,
            },
            select: { id: true, refundAmount: true },
          });

          if (linkedCtns.length > 0) {
            const totalCtnAmount = linkedCtns.reduce(
              (sum, ctn) => sum + Number(ctn.refundAmount),
              0,
            );

            await tx.returnOrder.updateMany({
              where: { id: { in: linkedCtns.map((c) => c.id) } },
              data: {
                status: 5,
                statusValue: 'Đã hủy',
              },
            });

            updateData.paidAmount = Math.max(
              0,
              Number(currentInvoice.paidAmount) - totalCtnAmount,
            );
          }

          if (
            dto.cancelPayments &&
            currentInvoice.payments &&
            currentInvoice.payments.length > 0
          ) {
            const paymentIds = currentInvoice.payments.map((p) => p.id);
            const paymentCodes = currentInvoice.payments
              .map((p) => p.code)
              .filter((c): c is string => !!c);
            const explicitCashFlowIds = currentInvoice.payments
              .map((p) => p.cashFlowId)
              .filter((cfId): cfId is number => cfId != null);

            // Soft-cancel cashFlow: ưu tiên cashFlowId, fallback match theo code
            // (cover cả historical data có cashFlowId = NULL)
            const orConditions: any[] = [];
            if (explicitCashFlowIds.length > 0) {
              orConditions.push({ id: { in: explicitCashFlowIds } });
            }
            if (paymentCodes.length > 0) {
              orConditions.push({ code: { in: paymentCodes } });
            }

            if (orConditions.length > 0) {
              await tx.cashFlow.updateMany({
                where: {
                  OR: orConditions,
                  status: { not: 2 },
                },
                data: { status: 2, statusValue: 'Đã hủy' },
              });
            }

            // Soft-cancel invoicePayment
            await tx.invoicePayment.updateMany({
              where: { id: { in: paymentIds } },
              data: { status: 2, statusValue: 'Đã hủy' },
            });

            // Reset paidAmount = 0 (cả CTN + cash đều bị hủy)
            updateData.paidAmount = 0;
          }

          updateData.debtAmount = 0;

          if (currentInvoice.customerId && currentInvoice.customer) {
            shouldUpdateCustomerDebt = true;
          }
        }

        updateData.status = dto.status;
        updateData.statusValue = getStatusLabel(dto.status);
      }

      // Xử lý items khi chỉ thay đổi giá (cùng sản phẩm, cùng số lượng)
      if (
        dto.items &&
        (!dto.status || dto.status !== INVOICE_STATUS.CANCELLED)
      ) {
        await tx.invoiceDetail.deleteMany({ where: { invoiceId: id } });

        // Revert log KM cũ trước khi re-validate (tránh lệch usageCount).
        const inPlaceOldLogs = await tx.invoicePromotionLog.findMany({
          where: { invoiceId: id, status: 'applied' },
          select: { id: true, promotionId: true },
        });
        if (inPlaceOldLogs.length > 0) {
          for (const lg of inPlaceOldLogs) {
            await tx.promotion.updateMany({
              where: { id: lg.promotionId },
              data: { usageCount: { decrement: 1 } },
            });
          }
          await tx.invoicePromotionLog.updateMany({
            where: { id: { in: inPlaceOldLogs.map((l) => l.id) } },
            data: { status: 'reverted' },
          });
        }

        // Chạy engine KM để re-validate + sinh lại dòng quà (kể cả khi user
        // sửa giá dòng X → thay đổi điều kiện KM). skipPromotions === true →
        // giữ dto.items nguyên.
        let inPlaceItems: any[] = dto.items as any[];
        let inPlaceExtraDiscount = 0;
        let inPlacePromoLogs: any[] = [];
        if (dto.skipPromotions !== true) {
          const promo = await this.processPromotions(tx, dto as any);
          inPlaceItems = promo.effectiveItems;
          inPlaceExtraDiscount = promo.extraInvoiceDiscount;
          inPlacePromoLogs = promo.logs;
        }

        const totalAmount = inPlaceItems.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        const discountAmount =
          dto.discountAmount && dto.discountAmount > 0
            ? dto.discountAmount + inPlaceExtraDiscount
            : (totalAmount * (dto.discountRatio || 0)) / 100 +
              inPlaceExtraDiscount;
        const grandTotal = totalAmount - discountAmount;

        // Tổng invoicePayment còn active (loại đã hủy)
        const payments = await tx.invoicePayment.findMany({
          where: { invoiceId: id, status: { not: 2 } },
        });
        const sumPayments = payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );

        // Tổng CTN còn active (manual_offset, status=4) — tránh ghi đè mất phần CTN
        const ctns = await tx.returnOrder.findMany({
          where: { invoiceId: id, refundType: 'manual_offset', status: 4 },
          select: { refundAmount: true },
        });
        const sumCtns = ctns.reduce(
          (sum, c) => sum + Number(c.refundAmount),
          0,
        );

        const paidAmount = sumPayments + sumCtns;
        const debtAmount = grandTotal - paidAmount;

        let status: number = currentInvoice.status;
        if (
          status !== INVOICE_STATUS.CANCELLED &&
          status !== INVOICE_STATUS.FAILED_DELIVERY
        ) {
          // Chỉ chuyển trạng thái dựa trên thanh toán khi hóa đơn đã giao thành công.
          // Các trạng thái khác (PROCESSING, PACKED, LOADING) giữ nguyên.
          if (debtAmount <= 0) {
            if (status === INVOICE_STATUS.DELIVERED) {
              status = INVOICE_STATUS.COMPLETED;
            }
          } else {
            if (status === INVOICE_STATUS.COMPLETED) {
              status = INVOICE_STATUS.DELIVERED;
            }
          }
        }

        updateData.totalAmount = totalAmount;
        updateData.discount = discountAmount;
        updateData.discountRatio = dto.discountRatio || 0;
        updateData.grandTotal = grandTotal;
        updateData.debtAmount = debtAmount;
        updateData.paidAmount = paidAmount;
        updateData.status = status;
        updateData.statusValue = getStatusLabel(status);

        updateData.details = {
          create: inPlaceItems.map((item) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: item.productName,
            quantity: item.quantity,
            price: item.price,
            discount: item.discount || 0,
            discountRatio: item.discountRatio || 0,
            totalPrice: item.totalPrice,
            note: item.note,
            conditionType: item.conditionType || 'normal',
            soldExpiryDate: item.soldExpiryDate
              ? new Date(item.soldExpiryDate)
              : null,
            lineType: item.lineType || 'normal',
            isGift: item.isGift || false,
            promotionId: item.promotionId ?? null,
          })),
        };

        // Ghi log KM mới + tăng usageCount cho HĐ đang sửa.
        if (inPlacePromoLogs.length > 0) {
          await tx.invoicePromotionLog.createMany({
            data: inPlacePromoLogs.map((l) => ({ ...l, invoiceId: id })),
          });
          await tx.promotion.updateMany({
            where: { id: { in: inPlacePromoLogs.map((l) => l.promotionId) } },
            data: { usageCount: { increment: 1 } },
          });
        }
      }

      if (dto.delivery) {
        // Snapshot địa chỉ cũ+mới theo customerId (ưu tiên dto, fallback currentInvoice).
        const inPlaceCustomerId = dto.customerId ?? currentInvoice.customerId;
        const inPlaceAddrSnapshot = await resolveDeliveryAddress(
          tx,
          inPlaceCustomerId,
        );
        await tx.invoiceDelivery.deleteMany({
          where: { invoiceId: id },
        });
        updateData.delivery = {
          create: {
            receiver: dto.delivery.receiver,
            contactNumber: dto.delivery.contactNumber,
            address: dto.delivery.address,
            locationName: dto.delivery.locationName,
            wardName: dto.delivery.wardName,
            oldCityName: inPlaceAddrSnapshot.oldCityName,
            oldDistrictName: inPlaceAddrSnapshot.oldDistrictName,
            oldWardName: inPlaceAddrSnapshot.oldWardName,
            newCityName: inPlaceAddrSnapshot.newCityName,
            newWardName: inPlaceAddrSnapshot.newWardName,
            weight: dto.delivery.weight,
            length: dto.delivery.length,
            width: dto.delivery.width,
            height: dto.delivery.height,
            noteForDriver: dto.delivery.noteForDriver,
          },
        };
      }

      // Chỉ động đến priceBook khi DTO chủ động gửi.
      // dto.priceBookId === undefined / null → giữ nguyên giá trị đã chốt
      //   (PUT không kèm priceBookId từ các flow patch nhỏ không được phép
      //    thay đổi bảng giá đã lưu).
      // dto.priceBookId > 0 → set theo bảng giá user chọn.
      // dto.priceBookId === 0 → "Bảng giá chung" → null/null.
      if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
        if (dto.priceBookId > 0) {
          const priceBook = await tx.priceBook.findFirst({
            where: { id: dto.priceBookId, isActive: true },
          });
          updateData.priceBookId = priceBook?.id || null;
          updateData.priceBookName = priceBook?.name || null;
        } else {
          // dto.priceBookId === 0 → "Bảng giá chung"
          updateData.priceBookId = null;
          updateData.priceBookName = null;
        }
      }

      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: updateData,
        include: {
          customer: true,
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
          payments: true,
          delivery: true,
          priceBook: true,
        },
      });

      // NGUỒN CHÂN LÝ: khi hủy hóa đơn (status=2 vừa ghi ở trên), log SALE trở
      // thành inactive → recalc onHand = Σ log active cho các sản phẩm của HĐ.
      if (dto.status === INVOICE_STATUS.CANCELLED && currentInvoice.branchId) {
        await recalcOnHandForPairs(
          tx,
          currentInvoice.details.map((d) => ({
            productId: d.productId,
            branchId: currentInvoice.branchId!,
          })),
        );
        // Log SALE_OUT của HĐ (status=2) trở thành inactive → recalc bucket
        // để hoàn lại tồn loại tồn (damaged/near_expiry/PROMO).
        await recalcConditionBucketsForPairs(
          tx,
          currentInvoice.details.map((d) => ({
            productId: d.productId,
            branchId: currentInvoice.branchId!,
          })),
        );
      }

      if (shouldUpdateCustomerDebt && currentInvoice.customerId) {
        await recalcCustomerDebt(tx, currentInvoice.customerId);
      }

      // Cập nhật lại công nợ khách hàng khi items thay đổi giá
      if (dto.items && !shouldUpdateCustomerDebt && currentInvoice.customerId) {
        await this.updateCustomerTotals(currentInvoice.customerId, tx);
      }

      if (currentInvoice.orderId) {
        await this.ordersService['updateOrderStatusByInvoices'](
          currentInvoice.orderId,
          tx,
        );
      }

      if (dto.status !== INVOICE_STATUS.CANCELLED) {
        const updatingUser = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'INVOICE_UPDATE',
          entityType: 'invoices',
          entityId: id.toString(),
          entityCode: currentInvoice.code,
          category: getCategoryFromActionCode('INVOICE_UPDATE'),
          severity: getSeverityFromActionCode('INVOICE_UPDATE'),
          snapshot: this.buildInvoiceSnapshot(updatedInvoice),
          message: renderAuditMessage('INVOICE_UPDATE', {
            invoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_UPDATE',
          userId: userId || currentInvoice.createdBy,
          userName: updatingUser?.name || updatingUser?.email || 'System',
          branchId: currentInvoice.branchId || undefined,
        });
      } else {
        // Nhánh hủy hóa đơn đơn giản (chỉ đổi status, không versioning).
        // Trước đây bị bỏ qua → không có vết audit khi hủy. Bổ sung INVOICE_CANCEL
        // để truy vết ai hủy hóa đơn.
        const cancellingUser = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'INVOICE_CANCEL',
          entityType: 'invoices',
          entityId: id.toString(),
          entityCode: currentInvoice.code,
          category: getCategoryFromActionCode('INVOICE_CANCEL'),
          severity: getSeverityFromActionCode('INVOICE_CANCEL'),
          snapshot: this.buildInvoiceSnapshot(updatedInvoice),
          message: renderAuditMessage('INVOICE_CANCEL', {
            invoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_CANCEL',
          userId: userId || currentInvoice.createdBy,
          userName: cancellingUser?.name || cancellingUser?.email || 'System',
          branchId: currentInvoice.branchId || undefined,
        });
      }

      return updatedInvoice;
    });

    // Sau khi commit: gửi lại tin nhắn Zalo cho các phiếu giao hàng đã được
    // repoint sang hóa đơn mới (versioning). Fire-and-forget, không chặn response.
    const uniquePackingSlipIds = [...new Set(affectedPackingSlipIds)];
    for (const slipId of uniquePackingSlipIds) {
      void this.packingSlipsService.resendDeliverySafe(slipId);
    }

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    return result;
  }

  async remove(id: number, userId: number) {
    const invoice = await this.findOne(id);

    await this.prisma.invoice.delete({ where: { id } });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, branchId: true },
    });

    await this.auditLogsService.create({
      actionType: 'DELETE',
      actionCode: 'INVOICE_DELETE',
      entityType: 'invoices',
      entityId: id.toString(),
      entityCode: (invoice as any).code,
      category: getCategoryFromActionCode('INVOICE_DELETE'),
      severity: getSeverityFromActionCode('INVOICE_DELETE'),
      snapshot: this.buildInvoiceSnapshot(invoice),
      message: renderAuditMessage('INVOICE_DELETE', {
        invoiceCode: (invoice as any).code,
      }),
      messageTemplate: 'INVOICE_DELETE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: (invoice as any).branchId || user?.branchId || undefined,
    });

    return { message: 'Xóa hóa đơn thành công' };
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [INVOICE_STATUS.CANCELLED] } },
      select: { grandTotal: true },
    });
    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );
    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased },
    });
    await recalcCustomerDebt(tx, customerId);
  }

  async createFromOrder(
    orderId: number,
    dto: CreateInvoiceFromOrderDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          payments: true,
          delivery: true,
          invoices: {
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
            include: { details: true },
          },
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              totalDebt: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
        },
      });

      if (!order) throw new NotFoundException('Order not found');
      if (order.status === ORDER_STATUS.CANCELLED) {
        throw new BadRequestException(
          'Không thể tạo hóa đơn từ đơn hàng đã hủy',
        );
      }
      if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BadRequestException('Đơn hàng đã hoàn thành');
      }
      if (!order.branchId) {
        throw new BadRequestException('Đơn hàng không có thông tin chi nhánh');
      }

      const invoicedQuantities: Record<number, number> = {};
      order.invoices.forEach((inv) => {
        inv.details.forEach((d) => {
          if (d.productId != null) {
            invoicedQuantities[d.productId] =
              (invoicedQuantities[d.productId] || 0) + Number(d.quantity);
          }
        });
      });

      const remainingItems = order.items
        .map((item) => {
          const invoiced = invoicedQuantities[item.productId] || 0;
          const remaining = Number(item.quantity) - invoiced;
          return { ...item, remainingQuantity: remaining };
        })
        .filter((item) => item.remainingQuantity > 0);

      if (remainingItems.length === 0) {
        throw new BadRequestException(
          'Tất cả sản phẩm trong đơn hàng đã được xuất hóa đơn',
        );
      }

      const usedDiscount = order.invoices.reduce(
        (sum, inv) => sum + Number(inv.discount),
        0,
      );
      const remainingDiscount = Number(order.discount) - usedDiscount;
      const discountForThisInvoice =
        remainingDiscount > 0 ? remainingDiscount : 0;

      const code = await this.generateSafeInvoiceCode(tx);

      const isFirstInvoice = order.invoices.length === 0;

      const totalPaidFromOrder = isFirstInvoice
        ? order.payments.reduce((sum, p) => sum + Number(p.amount), 0)
        : 0;
      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = totalPaidFromOrder + additionalPayment;

      const rawItemsToInvoice =
        dto.items && dto.items.length > 0
          ? dto.items
          : remainingItems.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.remainingQuantity,
              price: Number(item.price),
              discount: Number(item.discount),
              discountRatio: Number(item.discountRatio),
              totalPrice:
                (Number(item.price) - Number(item.discount)) *
                item.remainingQuantity,
              note: item.note,
              conditionType: (item as any).conditionType || 'normal',
              soldExpiryDate: (item as any).soldExpiryDate ?? null,
              lineType: (item as any).lineType || 'normal',
              isGift: (item as any).isGift || false,
              promotionId: (item as any).promotionId ?? null,
            }));

      // Stamp promotionId lên dòng thường (X) để mở lại HĐ còn opt-in KM.
      // Nếu FE gửi appliedPromotions → chạy engine để BE re-validate + sinh lại
      // dòng quà authoritatively (xử lý cả KM cộng dồn rewardSelections).
      const isPromoGiftLine = (it: any) =>
        !!(
          it?.isGift ||
          it?.lineType === 'gift' ||
          it?.lineType === 'discounted_buy'
        );

      // Chỉ kế thừa promotionId từ đúng dòng X (hàng mua điều kiện) của đơn gốc.
      // KHÔNG suy đoán từ dòng quà: khi SP quà trùng mã một SP bán thường
      // (vd tặng "testcombo1" trong khi cũng bán "testcombo1"), việc gán id của
      // quà cho dòng thường sẽ dán nhầm badge KM lên hàng bán giá thường.
      // Chỉ kế thừa cho dòng conditionType='normal' — hàng bục rách (damaged) /
      // cận date (near_expiry) KHÔNG hưởng KM nên không cần mang promotionId.
      const orderNormalPromoByProduct = new Map<number, number>();
      for (const oi of order.items) {
        if (
          oi.productId != null &&
          (oi as any).promotionId != null &&
          !isPromoGiftLine(oi) &&
          ((oi as any).conditionType || 'normal') === 'normal'
        ) {
          orderNormalPromoByProduct.set(
            oi.productId,
            Number((oi as any).promotionId),
          );
        }
      }

      const itemsToInvoice = rawItemsToInvoice.map((item: any) => {
        if (isPromoGiftLine(item)) {
          return {
            ...item,
            lineType: item.lineType || (item.isGift ? 'gift' : 'normal'),
            isGift: !!(item.isGift || item.lineType === 'gift'),
            promotionId: item.promotionId ?? null,
          };
        }
        // Hàng bục rách / cận date không được hưởng KM → luôn promotionId=null.
        if ((item.conditionType || 'normal') !== 'normal') {
          return {
            ...item,
            lineType: item.lineType || 'normal',
            isGift: false,
            promotionId: null,
          };
        }
        let promotionId =
          item.promotionId != null ? Number(item.promotionId) : null;
        if (promotionId == null || Number.isNaN(promotionId)) {
          const enabled = item.enabledPromotionIds;
          if (Array.isArray(enabled) && enabled.length > 0) {
            promotionId = Number(enabled[0]);
          }
        }
        if (
          (promotionId == null || Number.isNaN(promotionId)) &&
          item.productId != null &&
          orderNormalPromoByProduct.has(item.productId)
        ) {
          promotionId = orderNormalPromoByProduct.get(item.productId)!;
        }
        return {
          ...item,
          lineType: item.lineType || 'normal',
          isGift: false,
          promotionId:
            promotionId != null && !Number.isNaN(promotionId)
              ? promotionId
              : null,
        };
      });

      // Chạy engine KM nếu FE gửi appliedPromotions (user bật KM ở POS).
      // - Re-validate trần/điều kiện, sinh lại dòng quà authoritatively (kể cả
      //   KM cộng dồn rewardSelections), ghi InvoicePromotionLog + tăng usageCount.
      // - Tránh double-count với order log: nếu order đã ghi log cùng KM (đơn mới
      //   có KM), revert order log trước khi ghi HĐ log. HĐ "tiếp quản" tracking.
      // - skipPromotions === true hoặc không gửi appliedPromotions → giữ nguyên
      //   itemsToInvoice (kế thừa dòng quà từ payload/đơn gốc), không chạy engine.
      let effectiveItems = itemsToInvoice;
      let extraInvoiceDiscount = 0;
      let promoLogs: any[] = [];
      const hasAppliedPromos =
        (dto.appliedPromotions && dto.appliedPromotions.length > 0) ||
        (dto.appliedPromotionIds && dto.appliedPromotionIds.length > 0);
      if (!dto.skipPromotions && hasAppliedPromos) {
        const promo = await this.processPromotions(tx, {
          items: itemsToInvoice as any,
          branchId: order.branchId,
          customerId: order.customerId ?? undefined,
          soldById: dto.soldById ?? order.soldById ?? undefined,
          purchaseDate: new Date().toISOString(),
          appliedPromotions: dto.appliedPromotions,
          appliedPromotionIds: dto.appliedPromotionIds,
        } as any,
        { reconstructCumulativeChoices: true },
        );
        effectiveItems = promo.effectiveItems;
        extraInvoiceDiscount = promo.extraInvoiceDiscount;
        promoLogs = promo.logs;
      }
      effectiveItems = await this.markPromoStockDeductionItems(
        tx,
        effectiveItems,
      );

      const totalAmount = effectiveItems.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );

      const grandTotal =
        totalAmount - discountForThisInvoice - extraInvoiceDiscount;
      const debtAmount = grandTotal - totalPaid;

      // Hóa đơn tạo từ order luôn bắt đầu ở PROCESSING — chưa giao hàng nên không thể là COMPLETED.
      const status = INVOICE_STATUS.PROCESSING;

      const orderCustomer = order.customerId
        ? await tx.customer.findUnique({
            where: { id: order.customerId },
            select: { id: true },
          })
        : null;

      const parentCustomerId = orderCustomer ? orderCustomer.id : null;

      const invoice = await tx.invoice.create({
        data: {
          code,
          orderId: order.id,
          customerId: order.customerId,
          parentCustomerId,
          branchId: order.branchId,
          soldById: dto.soldById ?? order.soldById,
          saleChannelId: order.saleChannelId,
          priceBookId: order.priceBookId,
          priceBookName: order.priceBookName,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountForThisInvoice + extraInvoiceDiscount,
          discountRatio: 0,
          grandTotal,
          paidAmount: totalPaid,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          usingCod: order.usingCod || false,
          description: order.description,
          createdBy: userId,
          customerDebtSnapshot: null,
          details: {
            create: effectiveItems.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount,
              discountRatio: item.discountRatio,
              totalPrice: item.totalPrice,
              note: item.note,
              conditionType: item.conditionType || 'normal',
              soldExpiryDate: item.soldExpiryDate
                ? new Date(item.soldExpiryDate)
                : null,
              lineType: item.lineType || 'normal',
              isGift: item.isGift || false,
              promotionId: item.promotionId ?? null,
            })),
          },
          ...(order.delivery && {
            delivery: {
              create: {
                receiver: order.delivery.receiver,
                contactNumber: order.delivery.contactNumber,
                address: order.delivery.address,
                locationName: order.delivery.locationName,
                wardName: order.delivery.wardName,
                oldCityName: order.delivery.oldCityName,
                oldDistrictName: order.delivery.oldDistrictName,
                oldWardName: order.delivery.oldWardName,
                newCityName: order.delivery.newCityName,
                newWardName: order.delivery.newWardName,
                weight: order.delivery.weight,
                weightUnit: order.delivery.weightUnit || 'g',
                length: order.delivery.length,
                width: order.delivery.width,
                height: order.delivery.height,
              },
            },
          }),
        },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: {
            include: {
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
          priceBook: true,
        },
      });

      const soldByName = await this.prisma.user.findUnique({
        where: { id: Number(order.soldById) },
        select: { name: true },
      });

      const createdByName = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      // Actor cho InventoryLog (xuất kho bán từ đơn hàng). Truy vết ai xuất kho.
      const fromOrderLogActor = buildInventoryLogActor(
        userId,
        createdByName?.name,
      );

      const invoiceData = invoice;

      const cashFlowIdsToUpdate: number[] = [];

      if (isFirstInvoice && totalPaidFromOrder > 0) {
        for (const orderPayment of order.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TTTU${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: orderPayment.amount,
              transDate: orderPayment.paymentDate,
              method: orderPayment.paymentMethod || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.addresses?.[0]?.address || null,
              description: `Thu tiền tạm ứng từ đơn hàng ${order.code} sang hóa đơn ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: null,
            },
          });

          cashFlowIdsToUpdate.push(cashFlow.id);

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: orderPayment.amount,
              paymentDate: orderPayment.paymentDate,
              paymentMethod: orderPayment.paymentMethod,
              description: `Thanh toán từ đơn hàng ${order.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      if (dto.payments && dto.payments.length > 0) {
        for (const payment of dto.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TT${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: payment.amount,
              transDate: new Date(),
              method: payment.method || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.addresses?.[0]?.address || null,
              description: `Thu tiền thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: null,
            },
          });

          cashFlowIdsToUpdate.push(cashFlow.id);

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: payment.amount,
              paymentDate: new Date(),
              paymentMethod: payment.method,
              description: `Thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      const branch = await this.prisma.branch.findUnique({
        where: { id: order.branchId },
        select: { id: true, name: true },
      });

      const touchedProductIds = new Set<number>();
      for (const item of effectiveItems) {
        const invSnapshot = await tx.inventory.findFirst({
          where: { productId: item.productId, branchId: order.branchId },
        });

        const condition = item.conditionType || 'normal';
        await this.validateConditionQuantity(
          tx,
          item.productId,
          order.branchId,
          item.quantity,
          condition,
          item.soldExpiryDate,
        );
        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: order.branchId },
          data: this.buildInventoryDeductData(item.quantity, condition, {
            isGift: !!(item.isGift || item.lineType === 'gift'),
            deductPromoStock: !!item.deductPromoStock,
          }),
        });
        touchedProductIds.add(item.productId);

        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            productCode: item.productCode || '',
            productName: item.productName || '',
            branchId: order.branchId,
            branchName: branch?.name || '',
            transactionType: 'SALE',
            refCode: invoice.code,
            refType: 'invoice',
            refId: invoice.id,
            quantity: -Number(item.quantity),
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
            transactionPrice: Number(item.price),
            partnerId: order.customerId || null,
            partnerName: order.customer?.name || null,
            ...buildInventoryLogBase(fromOrderLogActor),
          },
        });

        // Sổ cái loại tồn khi xuất HĐ từ đơn hàng.
        await this.writeSaleConditionLog(tx, {
          item,
          branchId: order.branchId,
          branchName: branch?.name || '',
          invoiceCode: invoice.code,
          invoiceId: invoice.id,
          transactionDate: invoice.purchaseDate,
          costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
        });
      }

      // Ghi log KM + tăng usageCount (HĐ "tiếp quản" tracking từ order).
      // Trước tiên revert order log cùng KM (tránh double-count khi đơn đã có KM).
      if (promoLogs.length > 0) {
        const promoIds = promoLogs.map((l) => l.promotionId);
        const orderLogs = await tx.invoicePromotionLog.findMany({
          where: {
            orderId: order.id,
            status: 'applied',
            promotionId: { in: promoIds },
          },
          select: { id: true, promotionId: true },
        });
        if (orderLogs.length > 0) {
          for (const lg of orderLogs) {
            await tx.promotion.updateMany({
              where: { id: lg.promotionId },
              data: { usageCount: { decrement: 1 } },
            });
          }
          await tx.invoicePromotionLog.updateMany({
            where: { id: { in: orderLogs.map((l) => l.id) } },
            data: { status: 'reverted' },
          });
        }
        await tx.invoicePromotionLog.createMany({
          data: promoLogs.map((l) => ({ ...l, invoiceId: invoice.id })),
        });
        await tx.promotion.updateMany({
          where: { id: { in: promoIds } },
          data: { usageCount: { increment: 1 } },
        });
      }

      await recalcOnHandForPairs(
        tx,
        effectiveItems.map((i) => ({
          productId: i.productId,
          branchId: order.branchId,
        })),
      );

      // Recalc cache bucket từ sổ cái cho mọi sản phẩm vừa xuất HĐ từ đơn.
      await recalcConditionBucketsForPairs(
        tx,
        effectiveItems.map((i) => ({
          productId: i.productId,
          branchId: order.branchId,
        })),
      );

      const allInvoicedQty: Record<number, number> = {};
      const updatedInvoices = await tx.invoice.findMany({
        where: { orderId: order.id, status: { not: INVOICE_STATUS.CANCELLED } },
        include: { details: true },
      });
      updatedInvoices.forEach((inv) => {
        inv.details.forEach((d) => {
          if (d.productId != null) {
            allInvoicedQty[d.productId] =
              (allInvoicedQty[d.productId] || 0) + Number(d.quantity);
          }
        });
      });

      await this.ordersService['updateOrderStatusByInvoices'](
        order.id,
        tx,
        dto.forceComplete ?? false,
      );

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);

        const targetDebtCustomerId = order.customerId;
        const updatedCustomer = targetDebtCustomerId
          ? await tx.customer.findUnique({
              where: { id: targetDebtCustomerId },
              select: { totalDebt: true },
            })
          : null;

        const finalCustomerDebtSnapshot = updatedCustomer
          ? Number(updatedCustomer.totalDebt)
          : null;

        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            customerDebtSnapshot: finalCustomerDebtSnapshot,
          },
        });

        if (cashFlowIdsToUpdate.length > 0) {
          await tx.cashFlow.updateMany({
            where: {
              id: { in: cashFlowIdsToUpdate },
            },
            data: {
              customerDebtSnapshot: finalCustomerDebtSnapshot,
            },
          });
        }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVOICE_CREATE',
        entityType: 'invoices',
        entityId: invoice.id.toString(),
        entityCode: invoice.code,
        category: getCategoryFromActionCode('INVOICE_CREATE'),
        severity: getSeverityFromActionCode('INVOICE_CREATE'),
        snapshot: this.buildInvoiceSnapshot(
          invoiceData,
          order,
          soldByName,
          createdByName,
        ),
        message: renderAuditMessage('INVOICE_CREATE', {
          invoiceCode: invoice.code,
          orderCode: order.code,
          customerName: invoice.customer?.name || 'N/A',
        }),
        messageTemplate: 'INVOICE_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: invoice.branchId || undefined,
      });

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          branch: true,
          soldBy: true,
          order: { select: { code: true } },
        },
      });
    });
  }

  /**
   * B3 — Xuất hóa đơn từ phiếu ký gửi. Mirror createFromOrder NHƯNG:
   *   - KHÔNG trừ kho / KHÔNG ghi inventoryLog SALE (kho đã trừ ở B2 - PACKED).
   *   - Set invoice.consignmentId; lúc này mới phát sinh công nợ khách
   *     (recalcCustomerDebt cộng theo bảng invoices).
   *   - Hỗ trợ xuất nhiều hóa đơn (xuất từng phần): số đã xuất derive từ các
   *     hóa đơn con; sau khi tạo gọi updateConsignmentStatusByInvoices() để
   *     chuyển phiếu sang "Ký gửi một phần" / "Hoàn thành".
   */
  async createFromConsignment(
    consignmentId: number,
    dto: CreateInvoiceFromConsignmentDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const consignment = await tx.consignment.findUnique({
        where: { id: consignmentId },
        include: {
          items: true,
          invoices: {
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
            include: { details: true },
          },
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              totalDebt: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
        },
      });

      if (!consignment)
        throw new NotFoundException('Không tìm thấy phiếu ký gửi');
      if (consignment.status === CONSIGNMENT_STATUS.CANCELLED) {
        throw new BadRequestException(
          'Không thể xuất hóa đơn từ phiếu ký gửi đã hủy',
        );
      }
      if (consignment.status === CONSIGNMENT_STATUS.COMPLETED) {
        throw new BadRequestException('Phiếu ký gửi đã hoàn thành');
      }
      // Phải đã giao hàng (đã trừ kho ở B2) mới được xuất hóa đơn.
      if (consignment.status < CONSIGNMENT_STATUS.DELIVERED) {
        throw new BadRequestException(
          'Phiếu chưa giao hàng (chưa xử lý kho) — không thể xuất hóa đơn',
        );
      }
      if (!consignment.branchId) {
        throw new BadRequestException('Phiếu không có thông tin chi nhánh');
      }

      // Số đã xuất hóa đơn theo product (derive từ các hóa đơn con).
      const invoicedQuantities: Record<number, number> = {};
      consignment.invoices.forEach((inv) => {
        inv.details.forEach((d) => {
          if (d.productId != null) {
            invoicedQuantities[d.productId] =
              (invoicedQuantities[d.productId] || 0) + Number(d.quantity);
          }
        });
      });

      // Số đã hoàn về kho theo product (consignmentReturn đã nhận hàng = 2).
      // Phần này cũng làm giảm "ký gửi còn lại" giống xuất hóa đơn.
      const receivedReturns = await tx.consignmentReturn.findMany({
        where: { consignmentId, status: 2 },
        include: { details: true },
      });
      const returnedQuantities: Record<number, number> = {};
      receivedReturns.forEach((ro: any) => {
        ro.details.forEach((d: any) => {
          if (d.productId != null) {
            returnedQuantities[d.productId] =
              (returnedQuantities[d.productId] || 0) +
              Number(d.returnQuantity || 0);
          }
        });
      });

      const remainingItems = consignment.items
        .map((item) => {
          const invoiced = invoicedQuantities[item.productId] || 0;
          const returned = returnedQuantities[item.productId] || 0;
          const remaining = Number(item.quantity) - invoiced - returned;
          return { ...item, remainingQuantity: remaining };
        })
        .filter((item) => item.remainingQuantity > 0);

      if (remainingItems.length === 0) {
        throw new BadRequestException(
          'Tất cả sản phẩm trong phiếu ký gửi đã được xuất hóa đơn',
        );
      }

      // Chặn xuất vượt phần còn lại (FE gửi quantity tùy ý qua dto.items).
      if (dto.items && dto.items.length > 0) {
        const remainingByProduct: Record<number, number> = {};
        remainingItems.forEach((item) => {
          remainingByProduct[item.productId] = item.remainingQuantity;
        });
        for (const reqItem of dto.items) {
          const allowed = remainingByProduct[reqItem.productId] ?? 0;
          if (Number(reqItem.quantity) > allowed) {
            throw new BadRequestException(
              `Số lượng xuất hóa đơn (${reqItem.quantity}) vượt quá số còn lại (${allowed}) của sản phẩm ${reqItem.productCode || reqItem.productId}`,
            );
          }
        }
      }

      const usedDiscount = consignment.invoices.reduce(
        (sum, inv) => sum + Number(inv.discount),
        0,
      );
      const remainingDiscount = Number(consignment.discount) - usedDiscount;
      const discountForThisInvoice =
        remainingDiscount > 0 ? remainingDiscount : 0;

      const code = await this.generateSafeInvoiceCode(tx, 'HDKG');
      const isFirstInvoice = consignment.invoices.length === 0;

      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = additionalPayment;

      const itemsToInvoice =
        dto.items && dto.items.length > 0
          ? dto.items
          : remainingItems.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.remainingQuantity,
              price: Number(item.price),
              discount: Number(item.discount),
              discountRatio: Number(item.discountRatio),
              totalPrice:
                (Number(item.price) - Number(item.discount)) *
                item.remainingQuantity,
              note: item.note,
              conditionType: 'normal',
            }));

      const totalAmount = itemsToInvoice.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );
      const grandTotal = totalAmount - discountForThisInvoice;
      const debtAmount = grandTotal - totalPaid;

      // Hàng đã giao ở B2 → hóa đơn ký gửi tạo ở DELIVERED (đã giao).
      const status = INVOICE_STATUS.DELIVERED;

      const invoice = await tx.invoice.create({
        data: {
          code,
          consignmentId: consignment.id,
          customerId: consignment.customerId,
          parentCustomerId: consignment.customerId,
          branchId: consignment.branchId,
          soldById: dto.soldById ?? consignment.soldById,
          saleChannelId: consignment.saleChannelId,
          priceBookId: consignment.priceBookId,
          priceBookName: consignment.priceBookName,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountForThisInvoice,
          discountRatio: 0,
          grandTotal,
          paidAmount: totalPaid,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          description: consignment.description,
          createdBy: userId,
          customerDebtSnapshot: null,
          details: {
            create: itemsToInvoice.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount,
              discountRatio: item.discountRatio,
              totalPrice: item.totalPrice,
              note: item.note,
              conditionType: item.conditionType || 'normal',
              soldExpiryDate: (item as any).soldExpiryDate
                ? new Date((item as any).soldExpiryDate)
                : null,
            })),
          },
        },
        include: {
          details: true,
          payments: true,
          customer: {
            include: {
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
          priceBook: true,
        },
      });

      const cashFlowIdsToUpdate: number[] = [];

      if (dto.payments && dto.payments.length > 0) {
        for (const payment of dto.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TT${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: payment.amount,
              transDate: new Date(),
              method: payment.method || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.addresses?.[0]?.address || null,
              description: `Thu tiền thanh toán khi xuất hóa đơn ký gửi ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: null,
            },
          });

          cashFlowIdsToUpdate.push(cashFlow.id);

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: payment.amount,
              paymentDate: new Date(),
              paymentMethod: payment.method,
              description: `Thanh toán khi xuất hóa đơn ký gửi ${invoice.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      // KHÔNG trừ kho ở đây — kho đã trừ tại B2 (CONSIGNMENT_OUT).

      // Cập nhật trạng thái phiếu ký gửi theo các hóa đơn (một phần / hoàn thành).
      await this.consignmentsService.updateConsignmentStatusByInvoices(
        consignment.id,
        tx,
      );

      // Lúc này MỚI tính công nợ khách (recalcCustomerDebt cộng theo invoices).
      if (consignment.customerId) {
        await this.updateCustomerTotals(consignment.customerId, tx);

        const updatedCustomer = await tx.customer.findUnique({
          where: { id: consignment.customerId },
          select: { totalDebt: true },
        });
        const finalCustomerDebtSnapshot = updatedCustomer
          ? Number(updatedCustomer.totalDebt)
          : null;

        await tx.invoice.update({
          where: { id: invoice.id },
          data: { customerDebtSnapshot: finalCustomerDebtSnapshot },
        });

        if (cashFlowIdsToUpdate.length > 0) {
          await tx.cashFlow.updateMany({
            where: { id: { in: cashFlowIdsToUpdate } },
            data: { customerDebtSnapshot: finalCustomerDebtSnapshot },
          });
        }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVOICE_CREATE',
        entityType: 'invoices',
        entityId: invoice.id.toString(),
        entityCode: invoice.code,
        category: getCategoryFromActionCode('INVOICE_CREATE'),
        severity: getSeverityFromActionCode('INVOICE_CREATE'),
        // Bổ sung snapshot (trước đây nhánh createFromConsignment không có
        // snapshot → không truy vết được items đã xuất hóa đơn từ ký gửi).
        snapshot: this.buildInvoiceSnapshot(invoice),
        message: renderAuditMessage('INVOICE_CREATE', {
          invoiceCode: invoice.code,
          orderCode: consignment.code,
          customerName: invoice.customer?.name || 'N/A',
        }),
        messageTemplate: 'INVOICE_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: invoice.branchId || undefined,
      });

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          customer: true,
          branch: true,
          soldBy: true,
          consignment: { select: { code: true } },
        },
      });
    });
  }

  /**
   * Quyết định việc SỬA hóa đơn có cần tạo phiên bản mới (mã có hậu tố .xx) hay không.
   *
   * Trả về true (→ hủy HĐ cũ + clone HĐ .xx) khi có BẤT KỲ thay đổi nào sau:
   *   - Dòng sản phẩm: thêm/bớt SP, đổi số lượng, đổi giá bán, đổi giảm giá trên SP,
   *     đổi tỉ lệ giảm giá trên SP, đổi tình trạng hàng (conditionType).
   *   - Giảm giá toàn hóa đơn (discountAmount) hoặc tỉ lệ giảm giá hóa đơn (discountRatio).
   *   - Đổi bảng giá (priceBook A → B, hoặc về "bảng giá chung").
   *
   * KHÔNG xét: ghi chú hóa đơn (description) và ghi chú bưu tá (delivery.noteForDriver)
   * → các thay đổi này được cập nhật tại chỗ ở nhánh dưới, không tạo .xx, không đụng CTN.
   *
   * Mỗi điều kiện chỉ so sánh khi DTO chủ động gửi field tương ứng (!== undefined),
   * tránh false-positive với các flow patch nhỏ.
   */
  private hasVersionableChanges(
    currentInvoice: any,
    dto: UpdateInvoiceDto,
  ): boolean {
    // (1) Bảng giá: chuẩn hóa dto.priceBookId (>0 → id, 0 → null) rồi so với giá trị đã chốt.
    if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
      const normalizedPriceBookId =
        dto.priceBookId > 0 ? dto.priceBookId : null;
      if (normalizedPriceBookId !== (currentInvoice.priceBookId ?? null)) {
        return true;
      }
    }

    // (2) Giảm giá toàn hóa đơn (tiền).
    if (
      dto.discountAmount !== undefined &&
      Number(dto.discountAmount) !== Number(currentInvoice.discount)
    ) {
      return true;
    }

    // (3) Tỉ lệ giảm giá toàn hóa đơn.
    if (
      dto.discountRatio !== undefined &&
      Number(dto.discountRatio) !== Number(currentInvoice.discountRatio)
    ) {
      return true;
    }

    // (4) Dòng sản phẩm — so khớp đa tập chữ ký từng dòng.
    if (dto.items !== undefined) {
      const oldDetails = currentInvoice.details || [];
      if (oldDetails.length !== dto.items.length) return true;

      const buildSignature = (item: any): string =>
        [
          item.productId,
          item.conditionType || 'normal',
          Number(item.quantity),
          Number(item.price),
          Number(item.discount) || 0,
          Number(item.discountRatio) || 0,
        ].join('|');

      const oldSignatures = oldDetails.map(buildSignature).sort();
      const newSignatures = dto.items.map(buildSignature).sort();

      for (let i = 0; i < oldSignatures.length; i++) {
        if (oldSignatures[i] !== newSignatures[i]) return true;
      }
    }

    return false;
  }

  private async generateInvoiceCodeWithSuffix(
    baseCode: string,
    tx: any,
  ): Promise<string> {
    const basePart = baseCode.match(/^(HD\d{6})/)?.[1] || baseCode;

    const existingVersions = await tx.invoice.findMany({
      where: {
        code: { startsWith: basePart },
      },
      select: { code: true },
    });

    const suffixes = existingVersions
      .map((inv) => {
        const match = inv.code.match(/\.(\d+)$/);
        return match ? parseInt(match[1]) : 0;
      })
      .filter((s) => s > 0);

    const nextSuffix = suffixes.length > 0 ? Math.max(...suffixes) + 1 : 1;
    return `${basePart}.${String(nextSuffix).padStart(2, '0')}`;
  }

  private async generateSafeInvoiceCode(
    tx: any,
    prefix = 'HD',
  ): Promise<string> {
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allInvoices = await tx.invoice.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allInvoices
        .map((inv: any) => inv.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.invoice.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã hóa đơn duy nhất');
  }

  async findUnpaidByPartner(partnerId: number, partnerType: string) {
    if (partnerType !== 'C' && partnerType !== 'S') {
      return { data: [] };
    }

    const where: any = {
      status: {
        notIn: [INVOICE_STATUS.CANCELLED],
      },
      debtAmount: {
        gt: 0,
      },
    };

    if (partnerType === 'C') {
      where.customerId = partnerId;
    } else {
      return { data: [] };
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
        status: true,
        statusValue: true,
      },
      orderBy: {
        purchaseDate: 'desc',
      },
    });

    return { data: invoices };
  }

  async getPaymentHistory(invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { orderId: true },
    });

    const payments = await this.prisma.invoicePayment.findMany({
      where: { invoiceId },
      include: { cashFlow: true },
      orderBy: { createdAt: 'asc' },
    });

    let orderPayments: any[] = [];
    if (invoice?.orderId) {
      orderPayments = await this.prisma.orderPayment.findMany({
        where: { orderId: invoice.orderId },
        select: {
          id: true,
          code: true,
          amount: true,
          paymentDate: true,
          paymentMethod: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    }

    const enriched = payments.map((p) => {
      if (!p.code.startsWith('TTTUHD')) return p;

      const matched = orderPayments.find(
        (op) =>
          Number(op.amount) === Number(p.amount) &&
          new Date(op.paymentDate).getTime() ===
            new Date(p.paymentDate).getTime(),
      );

      return {
        ...p,
        sourceOrderPaymentCode: matched?.code ?? null,
      };
    });

    // [NEW] Lấy CTN (cấn trừ nợ) gắn với hóa đơn, normalize sang shape giống invoicePayment
    const ctns = await this.prisma.returnOrder.findMany({
      where: {
        invoiceId,
        refundType: 'manual_offset',
        status: { in: [4, 5] },
      },
      select: {
        id: true,
        code: true,
        refundAmount: true,
        refundConfirmedAt: true,
        createdAt: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const ctnRows = ctns.map((c) => ({
      id: -c.id, // negative để không trùng id với invoicePayment
      code: c.code,
      invoiceId,
      amount: c.refundAmount,
      paymentDate: c.refundConfirmedAt || c.createdAt,
      createdAt: c.createdAt,
      paymentMethod: null,
      status: c.status === 5 ? 2 : 1, // map: 4→1 (active), 5→2 (cancelled) để FE dùng cùng convention
      cashFlow: null,
      isCTN: true,
    }));

    return [...enriched, ...ctnRows].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async findForReturnOrder(query: {
    search?: string;
    branchId?: number;
    limit?: number;
  }) {
    const { search, branchId, limit = 20 } = query;

    const where: any = {
      status: {
        in: [
          INVOICE_STATUS.COMPLETED,
          INVOICE_STATUS.PROCESSING,
          INVOICE_STATUS.PACKED,
          INVOICE_STATUS.LOADING,
          INVOICE_STATUS.DELIVERED,
        ],
      },
    };

    if (branchId) where.branchId = branchId;
    if (search && search.trim()) {
      const term = search.trim();
      const matchedIds = await searchCustomerIds(this.prisma, term);
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: {
        details: true,
        customer: { select: { id: true, name: true, code: true } },
        soldBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (invoices.length === 0) return [];

    const invoiceIds = invoices.map((inv) => inv.id);

    // ── Lấy tất cả phiếu trả hàng (trừ đã hủy) liên quan đến các hóa đơn này
    const existingReturns = await this.prisma.returnOrder.findMany({
      where: {
        status: { notIn: [5] }, // 5 = CANCELLED
        details: {
          some: { invoiceId: { in: invoiceIds } },
        },
      },
      select: {
        status: true,
        details: {
          where: { invoiceId: { in: invoiceIds } },
          select: {
            invoiceId: true,
            productId: true,
            requestQuantity: true,
            confirmedQuantity: true,
          },
        },
      },
    });

    // ── Status đã nhập kho (bước 2 trở lên): dùng confirmedQuantity (số thực tế nhập)
    // ── Status chưa nhập kho (bước 1, draft):  dùng requestQuantity (để block double-submit)
    const CONFIRMED_STATUSES = new Set([2, 3, 4]); // STOCK_RECEIVED, REFUND_REQUESTED, COMPLETED

    const returnedMap: Record<string, number> = {};
    existingReturns.forEach((ro) => {
      const useConfirmed = CONFIRMED_STATUSES.has(ro.status);
      ro.details.forEach((d) => {
        const key = `${d.invoiceId}-${d.productId}`;
        const qty = useConfirmed
          ? Number(d.confirmedQuantity ?? 0)
          : Number(d.requestQuantity ?? 0);
        returnedMap[key] = (returnedMap[key] || 0) + qty;
      });
    });

    return invoices
      .map((inv) => {
        const mappedDetails = inv.details
          .map((d) => {
            const key = `${inv.id}-${d.productId}`;
            const returned = returnedMap[key] || 0;
            const remaining = Number(d.quantity) - returned;
            return {
              ...d,
              alreadyReturned: returned,
              remainingQuantity: remaining,
            };
          })
          .filter((d) => d.remainingQuantity > 0);

        return {
          ...inv,
          details: mappedDetails,
        };
      })
      .filter((inv) => inv.details.length > 0);
  }

  // ── Lấy hóa đơn cho luồng báo đơn (giao hàng / đóng hàng / loading)
  // Trả minimal data: id, code, customer.name, grandTotal, branchId
  // Dùng cho dropdown chọn invoice ở form báo đơn — không cần invoices:view
  async findForPacking(query: {
    branchId?: number;
    pageSize?: number;
    search?: string;
    excludeDelivered?: boolean;
  }) {
    const { branchId, pageSize = 100, search, excludeDelivered } = query;
    const take = Math.min(Math.max(pageSize, 1), 200);

    const where: any = {};
    if (branchId) where.branchId = branchId;

    // Khi tạo phiếu LOADING / ĐÓNG HÀNG: loại hóa đơn đã giao hàng thành công
    // (DELIVERED) hoặc đã hoàn thành (COMPLETED) — không cho báo đơn lại.
    if (excludeDelivered) {
      where.status = {
        notIn: [INVOICE_STATUS.DELIVERED, INVOICE_STATUS.COMPLETED],
      };
    }

    const keyword = search?.trim();
    if (keyword) {
      const matchedIds = await searchCustomerIds(this.prisma, keyword);
      where.OR = [
        { code: { contains: keyword } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    const data = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true,
        code: true,
        branchId: true,
        grandTotal: true,
        purchaseDate: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    // Trả cùng shape với findAll để frontend khỏi đổi nhiều
    return { data, total: data.length, page: 1, limit: take };
  }

  /**
   * Tổng quan giao hàng cho trang báo đơn:
   *  - stats: { total, delivered, pending } theo khoảng ngày + chi nhánh
   *  - data : danh sách hóa đơn CHƯA giao (có phân trang) để render bảng
   *
   * Định nghĩa trạng thái:
   *  - Giao thành công = DELIVERED(7) hoặc COMPLETED(1)
   *  - Chưa giao       = PROCESSING(3), PACKED(5), LOADING(6), FAILED_DELIVERY(4)
   *  - Tổng đơn        = mọi hóa đơn (trừ CANCELLED(2)) trong khoảng
   *
   * Khoảng thời gian:
   *  - Ưu tiên fromDate/toDate (lọc theo createdAt).
   *  - Nếu không có, fallback về `date` (1 ngày), mặc định hôm nay.
   */
  async findDeliveryOverview(query: {
    branchId?: number;
    date?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
    pageSize?: number;
    currentItem?: number;
    currentUser?: any;
  }) {
    const {
      branchId,
      date,
      fromDate,
      toDate,
      search,
      pageSize = 20,
      currentItem = 0,
      currentUser,
    } = query;
    const take = Math.min(Math.max(pageSize, 1), 100);

    // Xác định khoảng [start, end]. Ưu tiên fromDate/toDate, fallback `date`/hôm nay.
    const rangeStart = new Date(fromDate || toDate || date || new Date());
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(toDate || fromDate || date || new Date());
    rangeEnd.setHours(23, 59, 59, 999);

    const DELIVERED_STATUSES = [
      INVOICE_STATUS.DELIVERED,
      INVOICE_STATUS.COMPLETED,
    ];

    const baseWhere: any = {
      createdAt: { gte: rangeStart, lte: rangeEnd },
      status: { not: INVOICE_STATUS.CANCELLED },
    };
    if (branchId) baseWhere.branchId = branchId;

    // Danh sách hiển thị + ô "Chưa giao": CHỈ hóa đơn đang LOADING (lấy hàng).
    const listWhere: any = {
      ...baseWhere,
      status: INVOICE_STATUS.LOADING,
    };

    // Quyền: nếu bật canViewOnlyOwnLoadingInvoices → chỉ thấy hóa đơn nằm trong
    // phiếu loading mà chính user này là người loading (loadingById).
    if (currentUser?.canViewOnlyOwnLoadingInvoices && currentUser?.id) {
      listWhere.packingLoadings = {
        some: {
          packingLoading: {
            loadingById: currentUser.id,
            cancelledAt: null,
          },
        },
      };
    }

    const keyword = search?.trim();
    if (keyword) {
      const matchedIds = await searchCustomerIds(this.prisma, keyword);
      listWhere.OR = [
        { code: { contains: keyword } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    const [total, delivered, pending, listTotal, data] = await Promise.all([
      this.prisma.invoice.count({ where: baseWhere }),
      this.prisma.invoice.count({
        where: { ...baseWhere, status: { in: DELIVERED_STATUSES } },
      }),
      // "Chưa giao" = số hóa đơn đang LOADING (khớp với danh sách hiển thị bên dưới)
      this.prisma.invoice.count({ where: listWhere }),
      this.prisma.invoice.count({ where: listWhere }),
      this.prisma.invoice.findMany({
        where: listWhere,
        select: {
          id: true,
          code: true,
          status: true,
          statusValue: true,
          branchId: true,
          grandTotal: true,
          createdAt: true,
          customer: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take,
      }),
    ]);

    return {
      stats: { total, delivered, pending },
      data,
      total: listTotal,
    };
  }

  private buildProductChangesLog(
    oldDetails: any[],
    newItems: any[],
  ): {
    cancelLog: string;
    newLog: string;
  } {
    const oldMap = new Map(
      oldDetails.map((d) => [
        d.productId,
        {
          code: d.productCode,
          quantity: Number(d.quantity),
          price: Number(d.price),
        },
      ]),
    );

    const newMap = new Map(
      newItems.map((i) => [
        i.productId,
        {
          code: i.productCode,
          quantity: Number(i.quantity),
          price: Number(i.price),
        },
      ]),
    );

    const removed: string[] = [];
    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const [productId, oldData] of oldMap) {
      const newData = newMap.get(productId);
      if (!newData) {
        removed.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)} (Đã xóa)`,
        );
      } else if (oldData.quantity !== newData.quantity) {
        changed.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)} → ${newData.quantity}*${new Intl.NumberFormat('vi-VN').format(newData.price)}`,
        );
      } else {
        unchanged.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)}`,
        );
      }
    }

    for (const [productId, newData] of newMap) {
      if (!oldMap.has(productId)) {
        added.push(
          `${newData.code} : ${newData.quantity}*${new Intl.NumberFormat('vi-VN').format(newData.price)} (Mới thêm)`,
        );
      }
    }

    const cancelParts: string[] = [];
    if (unchanged.length > 0) {
      cancelParts.push(...unchanged);
    }
    if (changed.length > 0) {
      cancelParts.push(...changed.map((c) => c.split(' → ')[0]));
    }
    if (removed.length > 0) {
      cancelParts.push(...removed);
    }

    const newParts: string[] = [];
    if (unchanged.length > 0) {
      newParts.push(...unchanged);
    }
    if (changed.length > 0) {
      newParts.push(...changed.map((c) => c.split(' → ')[1]));
    }
    if (added.length > 0) {
      newParts.push(...added);
    }

    let changesSummary = '\n\nThay đổi:';
    if (removed.length > 0) {
      changesSummary += `\n- Đã xóa: ${removed.length} sản phẩm\n  ${removed.join('\n  ')}`;
    }
    if (added.length > 0) {
      changesSummary += `\n- Mới thêm: ${added.length} sản phẩm\n  ${added.join('\n  ')}`;
    }
    if (changed.length > 0) {
      changesSummary += `\n- Thay đổi số lượng: ${changed.length} sản phẩm\n  ${changed.join('\n  ')}`;
    }

    return {
      cancelLog: cancelParts.join('\n- ') + changesSummary,
      newLog: newParts.join('\n- '),
    };
  }

  private calculateReturnSummary(
    returnOrders: any[],
    grandTotal: number,
    paidAmount: number,
  ) {
    let totalReturnAmount = 0;
    let totalCashRefund = 0;
    let totalDebtOffset = 0;

    // CHỈ XỬ LÝ ReturnOrder có code bắt đầu bằng 'TH' (phiếu trả hàng)
    // Không tính CTN (cấn trừ nợ từ modal thanh toán) vì đã được tính vào paidAmount
    for (const ro of returnOrders) {
      if (!ro.code || !ro.code.startsWith('TH')) continue;

      const refundAmount = Number(ro.refundAmount || 0);

      // Trả hàng: Tổng refundAmount từ các phiếu đã nhập kho (status 2/3/4),
      // loại trừ phiếu đã hủy (status 5)
      if (ro.status >= 2 && ro.status !== 5) {
        totalReturnAmount += refundAmount;
      }

      // Phiếu chi: refundedAmount từ phiếu với refundType = 'cash_refund' (status = 4)
      if (ro.status === 4 && ro.refundType === 'cash_refund') {
        totalCashRefund += Number(ro.refundedAmount || 0);
      }

      // Cấn trừ nợ: refundAmount từ phiếu với refundType = 'debt_offset' (status = 4)
      if (ro.status === 4 && ro.refundType === 'debt_offset') {
        totalDebtOffset += refundAmount;
      }
    }

    // Credit = phần trả hàng vượt quá khoản nợ ban đầu (tiền khách đã trả, được hoàn lại)
    // Với hóa đơn chưa trả: debtBeforeReturn = grandTotal → credit = 0 → effectiveDebtOffset = 0
    // Với hóa đơn đã trả: debtBeforeReturn = 0 → credit = totalReturnAmount → effectiveDebtOffset = totalDebtOffset
    const debtBeforeReturn = grandTotal - paidAmount;
    const credit = Math.max(0, totalReturnAmount - debtBeforeReturn);
    const effectiveDebtOffset = Math.min(totalDebtOffset, credit);

    // Cấn trừ nợ chỉ hiển thị khi hóa đơn có thanh toán trước (paidAmount > 0)
    // Với hóa đơn chưa trả: "Trả hàng" đã đại diện cho việc giảm nợ rồi
    const displayDebtOffset = paidAmount > 0 ? -effectiveDebtOffset : 0;

    const remainingAmount =
      grandTotal -
      paidAmount -
      totalReturnAmount +
      totalCashRefund +
      effectiveDebtOffset;

    return {
      returnOrderAmount: totalReturnAmount,
      cashRefundAmount: totalCashRefund,
      debtOffsetAmount: effectiveDebtOffset,
      remainingAmount,
    };
  }

  private buildInvoiceSnapshot(
    invoice: any,
    order?: any,
    soldByName?: any,
    createdByName?: any,
  ) {
    return {
      code: invoice.code,
      purchaseDate: invoice.purchaseDate,
      statusValue: invoice.statusValue,
      grandTotal: Number(invoice.grandTotal),
      totalAmount: Number(invoice.totalAmount || 0),
      discount: Number(invoice.discount || 0),
      discountRatio: Number(invoice.discountRatio || 0),
      paidAmount: Number(invoice.paidAmount || 0),
      debtAmount: Number(invoice.debtAmount || 0),
      description: invoice.description,
      usingCod: invoice.usingCod,
      priceBookName: invoice.priceBookName || invoice.priceBook?.name || null,
      customer: invoice.customer
        ? { code: invoice.customer.code, name: invoice.customer.name }
        : null,
      order: order,
      soldBy:
        soldByName != null
          ? typeof soldByName === 'object'
            ? { name: soldByName.name }
            : { name: soldByName }
          : invoice.soldBy
            ? { name: invoice.soldBy.name }
            : null,
      branch: invoice.branch ? { name: invoice.branch.name } : null,
      items: (invoice.details || []).map((i: any) => ({
        productId: i.productId,
        productCode: i.productCode || i.product?.code,
        productName: i.productName || i.product?.name,
        quantity: Number(i.quantity),
        price: Number(i.price),
        discount: Number(i.discount || 0),
        isRewardPoint: i.isRewardPoint,
      })),
      delivery: invoice.delivery
        ? {
            receiver: invoice.delivery.receiver,
            contactNumber: invoice.delivery.contactNumber,
            address: invoice.delivery.address,
            wardName: invoice.delivery.wardName,
            // Địa chỉ cũ (3 cấp) + mới (2 cấp) — để shipper xem cả hai.
            oldCityName: invoice.delivery.oldCityName,
            oldDistrictName: invoice.delivery.oldDistrictName,
            oldWardName: invoice.delivery.oldWardName,
            newCityName: invoice.delivery.newCityName,
            newWardName: invoice.delivery.newWardName,
            weight: invoice.delivery.weight,
            length: invoice.delivery.length,
            width: invoice.delivery.width,
            height: invoice.delivery.height,
            price: invoice.delivery.price,
            noteForDriver: invoice.delivery.noteForDriver,
            statusValue: invoice.delivery.statusValue,
          }
        : null,
    };
  }

  /**
   * Đánh dấu dòng X phải trừ vào bucket PROMO theo cấu hình CTKM.
   * Dòng quà Y vốn đã trừ PROMO qua isGift; damaged/near_expiry không bị đổi.
   */
  private async markPromoStockDeductionItems(
    tx: any,
    items: any[],
  ): Promise<any[]> {
    const promotionIds = Array.from(
      new Set(
        items
          .filter(
            (item) =>
              item.promotionId != null &&
              (item.conditionType || 'normal') === 'normal',
          )
          .map((item) => Number(item.promotionId)),
      ),
    ).filter((id) => Number.isInteger(id)) as number[];

    if (promotionIds.length === 0) return items;

    const promotions = await tx.promotion.findMany({
      where: {
        id: { in: promotionIds },
        type: { in: ['BUY_X_GET_Y', 'BUY_N_GET_M_SAME'] },
        deductPromoStock: true,
      },
      select: { id: true },
    });
    const enabledIds = new Set(promotions.map((promotion: any) => promotion.id));

    return items.map((item) => ({
      ...item,
      deductPromoStock:
        (item.conditionType || 'normal') === 'normal' &&
        item.promotionId != null &&
        enabledIds.has(Number(item.promotionId)),
    }));
  }

  /**
   * Trừ kho khi xuất HĐ.
   * - conditionType damaged/near_expiry: trừ bucket tương ứng
   * - isGift/deductPromoStock: trừ promoQuantity (cho phép âm)
   */
  private buildInventoryDeductData(
    quantity: number,
    conditionType?: string,
    opts?: { isGift?: boolean; deductPromoStock?: boolean },
  ): Record<string, any> {
    const data: Record<string, any> = {
      onHand: { decrement: quantity },
    };
    if (conditionType === 'damaged') {
      data.damagedQuantity = { decrement: quantity };
    } else if (conditionType === 'near_expiry') {
      data.nearExpiryQuantity = { decrement: quantity };
    }
    if (opts?.isGift || opts?.deductPromoStock) {
      data.promoQuantity = { decrement: quantity };
    }
    return data;
  }

  /**
   * Xây dựng data object để hoàn kho (khi hủy hóa đơn).
   * Gift line: cộng lại promoQuantity (có thể từ số âm về 0/dương).
   */
  private buildInventoryRestoreData(
    quantity: number,
    conditionType?: string,
    opts?: { isGift?: boolean },
  ): Record<string, any> {
    const data: Record<string, any> = {
      onHand: { increment: quantity },
    };
    if (conditionType === 'damaged') {
      data.damagedQuantity = { increment: quantity };
    } else if (conditionType === 'near_expiry') {
      data.nearExpiryQuantity = { increment: quantity };
    }
    if (opts?.isGift) {
      data.promoQuantity = { increment: quantity };
    }
    return data;
  }

  /**
   * Validate số lượng damaged/near_expiry trước khi trừ kho — ĐỌC TỪ SỔ CÁI
   * StockConditionLog (nguồn chân lý), KHÔNG đọc cột cache Inventory (có thể
   * stale trước recalc). Với near_expiry còn kiểm tồn theo từng lô (expiryDate).
   */
  private async validateConditionQuantity(
    tx: any,
    productId: number,
    branchId: number,
    quantity: number,
    conditionType?: string,
    soldExpiryDate?: string | Date | null,
  ): Promise<void> {
    if (!conditionType || conditionType === 'normal') return;

    const totals = await computeBucketTotals(tx, productId, branchId);

    if (conditionType === 'damaged') {
      if (quantity > totals.damaged) {
        throw new BadRequestException(
          `Sản phẩm (ID: ${productId}) chỉ có ${totals.damaged} hàng bục rách, không đủ ${quantity}`,
        );
      }
    } else if (conditionType === 'near_expiry') {
      if (quantity > totals.nearExpiry) {
        throw new BadRequestException(
          `Sản phẩm (ID: ${productId}) chỉ có ${totals.nearExpiry} hàng cận date, không đủ ${quantity}`,
        );
      }
      // LUÔN validate theo LÔ, kể cả khi không chọn lô cụ thể.
      //
      // Không chọn lô → dòng bán được ghi sổ với expiryDate = null, tức trừ vào
      // "lô chưa xác định NSX". Nếu chỉ validate theo TỔNG, người bán có thể
      // bán số lượng lớn hơn tồn của lô null (vì tổng gồm cả các lô khác) →
      // lô null bị âm dù tổng bucket vẫn dương.
      const wanted = soldExpiryDate
        ? new Date(soldExpiryDate).toISOString().slice(0, 10)
        : null;
      const lots = await computeNearExpiryLots(tx, productId, branchId);
      const lot = lots.find((l) => l.expiryDate === wanted);
      const lotQty = lot ? lot.quantity : 0;
      if (quantity > lotQty) {
        const lotLabel = wanted
          ? `lô cận date ${wanted}`
          : 'lô cận date chưa xác định NSX';
        throw new BadRequestException(
          `Sản phẩm (ID: ${productId}) ${lotLabel} chỉ còn ${lotQty}, không đủ ${quantity}. Vui lòng chọn lô (NSX) phù hợp.`,
        );
      }
    }
  }

  /**
   * Ghi sổ cái StockConditionLog cho 1 dòng hóa đơn khi XUẤT BÁN (SALE_OUT).
   * Chỉ ghi nếu dòng thuộc 1 bucket (damaged/near_expiry hoặc quà = PROMO).
   * quantity ghi ÂM (rời khỏi bucket). Không ghi log đảo khi hủy — active-finder
   * refType='invoice' (status != 2) tự loại log của hóa đơn đã hủy khi recalc.
   */
  private async writeSaleConditionLog(
    tx: any,
    params: {
      item: any;
      branchId: number;
      branchName: string;
      invoiceCode: string;
      invoiceId: number;
      transactionDate: Date;
      costPrice?: number;
      createdByName?: string | null;
    },
  ): Promise<void> {
    const { item } = params;
    if (item.productId == null) return;

    const isGift = !!(item.isGift || item.lineType === 'gift');
    let bucket: string | null = null;
    if (item.conditionType === 'damaged') bucket = BUCKET_DAMAGED;
    else if (item.conditionType === 'near_expiry') bucket = BUCKET_NEAR_EXPIRY;
    else if (isGift || item.deductPromoStock) bucket = BUCKET_PROMO;
    if (!bucket) return;

    await tx.stockConditionLog.create({
      data: {
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || '',
        branchId: params.branchId,
        branchName: params.branchName || '',
        bucket,
        transactionType: 'SALE_OUT',
        refCode: params.invoiceCode,
        refType: 'invoice',
        refId: params.invoiceId,
        quantity: -Number(item.quantity),
        expiryDate:
          bucket === BUCKET_NEAR_EXPIRY && item.soldExpiryDate
            ? new Date(item.soldExpiryDate)
            : null,
        costPrice: params.costPrice ?? 0,
        transactionDate: params.transactionDate,
        createdByName: params.createdByName ?? null,
      },
    });
  }

  private async buildInvoiceExportWhere(query: InvoiceQueryDto): Promise<any> {
    const {
      search,
      customerIds,
      branchId,
      branchIds,
      statusIds,
      fromDate,
      toDate,
      fromPurchaseDate,
      toPurchaseDate,
      fromCreatedDate,
      toCreatedDate,
      deliveryStatus,
      paymentMethod,
      bankAccountIds,
      invoiceCodeSearch,
      productSearch,
      customerSearch,
      deliveryCodeSearch,
      orderCodeSearch,
      descriptionSearch,
      productNoteSearch,
    } = query;

    const where: any = {};

    if (search) {
      const matchedIds = await searchCustomerIds(this.prisma, search);
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (invoiceCodeSearch) {
      where.code = { contains: invoiceCodeSearch, mode: 'insensitive' };
    }

    if (customerSearch) {
      const matchedIds = await searchCustomerIds(this.prisma, customerSearch);
      const ids = matchedIds.length > 0 ? matchedIds : [-1];
      where.customerId = where.customerId?.in
        ? { in: where.customerId.in.filter((id: number) => ids.includes(id)) }
        : { in: ids };
    }

    if (deliveryCodeSearch) {
      where.delivery = {
        ...where.delivery,
        deliveryCode: { contains: deliveryCodeSearch, mode: 'insensitive' },
      };
    }

    if (orderCodeSearch) {
      where.order = {
        code: { contains: orderCodeSearch, mode: 'insensitive' },
      };
    }

    if (descriptionSearch) {
      where.description = { contains: descriptionSearch, mode: 'insensitive' };
    }

    const detailsConditions: any = {};
    if (productSearch) {
      detailsConditions.OR = [
        { productCode: { contains: productSearch, mode: 'insensitive' } },
        { productName: { contains: productSearch, mode: 'insensitive' } },
      ];
    }
    if (productNoteSearch) {
      detailsConditions.note = {
        contains: productNoteSearch,
        mode: 'insensitive',
      };
    }
    if (Object.keys(detailsConditions).length > 0) {
      where.details = { some: detailsConditions };
    }

    if (customerIds?.length) {
      where.customerId = where.customerId?.in
        ? {
            in: where.customerId.in.filter((id: number) =>
              customerIds.includes(id),
            ),
          }
        : { in: customerIds };
    }
    if (branchIds?.length) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }

    if (statusIds?.length) where.status = { in: statusIds };

    if (fromDate || toDate || fromPurchaseDate || toPurchaseDate) {
      where.purchaseDate = {};
      if (fromDate || fromPurchaseDate)
        where.purchaseDate.gte = new Date((fromDate || fromPurchaseDate)!);
      if (toDate || toPurchaseDate)
        where.purchaseDate.lte = new Date((toDate || toPurchaseDate)!);
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    if (deliveryStatus) {
      if (deliveryStatus === 'none') where.delivery = null;
      else if (deliveryStatus === 'pending')
        where.delivery = { ...where.delivery, status: 1 };
      else if (deliveryStatus === 'delivered')
        where.delivery = { ...where.delivery, status: { gte: 2 } };
    }

    if (paymentMethod) {
      where.payments = { some: { paymentMethod } };
    }

    if (bankAccountIds?.length) {
      where.payments = {
        some: {
          ...(paymentMethod ? { paymentMethod } : {}),
          accountId: { in: bankAccountIds },
        },
      };
    }

    // ── Các filter dưới đây phải khớp với buildInvoiceListWhere, nếu không file
    // xuất ra sẽ chứa nhiều dữ liệu hơn danh sách đang hiển thị trên màn hình.
    if (query.fromUpdatedDate || query.toUpdatedDate) {
      where.updatedAt = {};
      if (query.fromUpdatedDate)
        where.updatedAt.gte = new Date(query.fromUpdatedDate);
      if (query.toUpdatedDate)
        where.updatedAt.lte = new Date(query.toUpdatedDate);
    }

    if (query.createdByIds?.length) {
      where.createdBy = { in: query.createdByIds };
    }

    if (query.soldByIds?.length) {
      where.soldById = { in: query.soldByIds };
    }

    if (query.saleChannelId) {
      where.saleChannelId = query.saleChannelId;
    }

    if (query.misaSyncStatus?.length) {
      where.misaSyncStatus = { in: query.misaSyncStatus };
    }

    if (query.misaEmployeeCodes?.length) {
      where.customer = {
        ...(where.customer || {}),
        misaEmployeeCode: { in: query.misaEmployeeCodes },
      };
    }

    // Trạng thái mã số thuế: lấy taxCode, fallback identificationNumber.
    // Gộp vào customer.AND để không ghi đè filter customer khác.
    if (query.taxCodeStatus === 'empty' || query.taxCodeStatus === 'filled') {
      const taxCondition =
        query.taxCodeStatus === 'empty'
          ? {
              AND: [
                { OR: [{ taxCode: null }, { taxCode: '' }] },
                {
                  OR: [
                    { identificationNumber: null },
                    { identificationNumber: '' },
                  ],
                },
              ],
            }
          : {
              OR: [
                {
                  AND: [{ taxCode: { not: null } }, { taxCode: { not: '' } }],
                },
                {
                  AND: [
                    { identificationNumber: { not: null } },
                    { identificationNumber: { not: '' } },
                  ],
                },
              ],
            };
      where.customer = {
        ...(where.customer || {}),
        AND: [...(where.customer?.AND || []), taxCondition],
      };
    }

    // Cảnh báo lệch giá bảng giá 2/3 — cùng truy vấn với buildInvoiceListWhere.
    if (query.priceWarning) {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT i.id FROM invoices i
        WHERE i.status <> 2 AND i."priceBookId" IN (2, 3)
          AND EXISTS (
            SELECT 1 FROM invoice_details d
            JOIN price_book_details pbd
              ON pbd."productId" = d."productId"
             AND pbd."priceBookId" = i."priceBookId"
             AND pbd."isActive" = true
            WHERE d."invoiceId" = i.id
              AND (d.price - d.discount) < pbd.price
          )`;
      const ids = rows.map((r) => Number(r.id));
      where.id = { in: ids.length ? ids : [-1] };
    }

    return where;
  }

  getDetailColumns(): Array<{ key: string; header: string; width: number }> {
    return [
      { key: 'branchName', header: 'Chi nhánh', width: 18 },
      { key: 'invoiceCode', header: 'Mã hóa đơn', width: 16 },
      { key: 'purchaseDate', header: 'Thời gian', width: 18 },
      { key: 'createdAt', header: 'Thời gian tạo', width: 18 },
      { key: 'updatedAt', header: 'Ngày cập nhật', width: 18 },
      { key: 'orderCode', header: 'Mã đặt hàng', width: 16 },
      { key: 'customerCode', header: 'Mã khách hàng', width: 14 },
      { key: 'customerName', header: 'Tên khách hàng', width: 22 },
      { key: 'customerGroupName', header: 'Nhóm khách hàng', width: 20 },
      { key: 'customerPhone', header: 'Điện thoại', width: 14 },
      { key: 'customerAddress', header: 'Địa chỉ KH', width: 28 },
      { key: 'customerLocationName', header: 'Khu vực KH', width: 18 },
      { key: 'customerWardName', header: 'Phường-Xã KH', width: 18 },
      { key: 'priceBookName', header: 'Bảng giá', width: 16 },
      { key: 'soldByName', header: 'Người bán', width: 18 },
      { key: 'creatorName', header: 'Người tạo', width: 18 },
      { key: 'deliveryReceiver', header: 'Người nhận', width: 18 },
      { key: 'deliveryPhone', header: 'ĐT người nhận', width: 14 },
      { key: 'deliveryAddress', header: 'Địa chỉ giao', width: 28 },
      { key: 'deliveryLocationName', header: 'Khu vực giao', width: 18 },
      { key: 'deliveryWardName', header: 'Phường-Xã giao', width: 18 },
      { key: 'deliveryWeight', header: 'Trọng lượng (gram)', width: 20 },
      { key: 'deliveryNote', header: 'Ghi chú giao hàng', width: 22 },
      { key: 'description', header: 'Ghi chú', width: 22 },
      { key: 'totalAmount', header: 'Tổng tiền hàng', width: 16 },
      { key: 'discount', header: 'Giảm giá HĐ', width: 14 },
      { key: 'grandTotal', header: 'Khách cần trả', width: 16 },
      { key: 'paidAmount', header: 'Khách đã trả', width: 16 },
      { key: 'cashPayment', header: 'Tiền mặt', width: 14 },
      { key: 'cardPayment', header: 'Thẻ', width: 12 },
      { key: 'walletPayment', header: 'Ví', width: 12 },
      { key: 'bankTransferPayment', header: 'Chuyển khoản', width: 16 },
      { key: 'rewardPoint', header: 'Điểm', width: 10 }, // no schema source → empty
      { key: 'voucherAmount', header: 'Voucher', width: 12 }, // no schema source → empty
      { key: 'voucherCode', header: 'Mã voucher', width: 14 }, // no schema source → empty
      { key: 'codAmount', header: 'Còn cần thu (COD)', width: 20 },
      { key: 'statusValue', header: 'Trạng thái', width: 16 },
      { key: 'productCode', header: 'Mã hàng', width: 14 },
      { key: 'productName', header: 'Tên hàng', width: 28 },
      { key: 'productNote', header: 'Ghi chú hàng hóa', width: 22 },
      { key: 'quantity', header: 'Số lượng', width: 12 },
      { key: 'unitPrice', header: 'Đơn giá', width: 14 },
      { key: 'detailDiscountRatio', header: 'Giảm giá %', width: 12 },
      { key: 'detailDiscount', header: 'Giảm giá', width: 14 },
      { key: 'sellingPrice', header: 'Giá bán', width: 14 },
      { key: 'totalPrice', header: 'Thành tiền', width: 16 },
    ];
  }

  // ─── EXPORT 1: Tổng quan (1 dòng/hóa đơn) ──────────────────────────────────
  async exportOverview(query: InvoiceQueryDto, res: Response): Promise<void> {
    const where = await this.buildInvoiceExportWhere(query);
    const BATCH_SIZE = 500;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Hóa đơn tổng quan');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã hóa đơn', key: 'invoiceCode', width: 16 },
      { header: 'Thời gian', key: 'purchaseDate', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 18 },
      { header: 'Mã đặt hàng', key: 'orderCode', width: 16 },
      { header: 'Mã khách hàng', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 22 },
      { header: 'Nhóm khách hàng', key: 'customerGroupName', width: 20 },
      { header: 'Điện thoại', key: 'customerPhone', width: 14 },
      { header: 'Địa chỉ KH', key: 'customerAddress', width: 28 },
      { header: 'Bảng giá', key: 'priceBookName', width: 16 },
      { header: 'Người bán', key: 'soldByName', width: 18 },
      { header: 'Người tạo', key: 'creatorName', width: 18 },
      { header: 'Người nhận', key: 'deliveryReceiver', width: 18 },
      { header: 'Ghi chú giao hàng', key: 'deliveryNote', width: 22 },
      { header: 'Ghi chú', key: 'description', width: 22 },
      { header: 'Tổng tiền hàng', key: 'totalAmount', width: 16 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Khách cần trả', key: 'grandTotal', width: 16 },
      { header: 'Khách đã trả', key: 'paidAmount', width: 16 },
      { header: 'Còn nợ', key: 'debtAmount', width: 14 },
      { header: 'Trạng thái', key: 'statusValue', width: 16 },
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

    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          createdAt: true,
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
          statusValue: true,
          description: true,
          priceBookName: true,
          branch: { select: { name: true } },
          customer: {
            select: {
              code: true,
              name: true,
              contactNumber: true,
              phone: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
              customerGroupDetails: {
                select: { customerGroup: { select: { name: true } } },
              },
            },
          },
          order: { select: { code: true } },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          delivery: { select: { receiver: true, noteForDriver: true } },
        },
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        stt++;
        const defaultAddr =
          (inv.customer as any)?.addresses?.[0]?.address ?? '';
        sheet
          .addRow({
            stt,
            branchName: inv.branch?.name ?? '',
            invoiceCode: inv.code,
            purchaseDate: new Date(inv.purchaseDate),
            createdAt: new Date(inv.createdAt),
            orderCode: inv.order?.code ?? '',
            customerCode: inv.customer?.code ?? 'Khách vãng lai',
            customerName: inv.customer?.name ?? 'Khách vãng lai',
            customerPhone:
              inv.customer?.contactNumber ?? (inv.customer as any)?.phone ?? '',
            customerAddress: defaultAddr,
            customerGroupName: ((inv.customer as any)?.customerGroupDetails ??
              [])
              .map((d: any) => d.customerGroup?.name)
              .filter(Boolean)
              .join(', '),
            priceBookName: inv.priceBookName ?? '',
            soldByName: inv.soldBy?.name ?? '',
            creatorName: inv.creator?.name ?? '',
            deliveryReceiver: inv.delivery?.receiver ?? '',
            deliveryNote: inv.delivery?.noteForDriver ?? '',
            description: inv.description ?? '',
            totalAmount: Number(inv.totalAmount),
            discount: Number(inv.discount),
            grandTotal: Number(inv.grandTotal),
            paidAmount: Number(inv.paidAmount),
            debtAmount: Number(inv.debtAmount),
            statusValue: inv.statusValue ?? '',
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  // ─── EXPORT 2: Chi tiết (1 dòng/sản phẩm) ──────────────────────────────────
  async exportDetail(
    query: InvoiceQueryDto,
    selectedColumns: string[],
    res: Response,
  ): Promise<void> {
    const where = await this.buildInvoiceExportWhere(query);
    const BATCH_SIZE = 500;
    const catalog = this.getDetailColumns();

    const activeCols =
      selectedColumns.length > 0
        ? catalog.filter((c) => selectedColumns.includes(c.key))
        : catalog;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Hóa đơn chi tiết');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      ...activeCols.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
      })),
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

    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          createdAt: true,
          updatedAt: true,
          totalAmount: true,
          discount: true,
          grandTotal: true,
          paidAmount: true,
          debtAmount: true,
          statusValue: true,
          description: true,
          priceBookName: true,
          usingCod: true,
          branch: { select: { name: true } },
          order: { select: { code: true } },
          customer: {
            select: {
              code: true,
              name: true,
              contactNumber: true,
              phone: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true, locationName: true, wardName: true },
              },
              customerGroupDetails: {
                select: { customerGroup: { select: { name: true } } },
              },
            },
          },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          delivery: {
            select: {
              receiver: true,
              contactNumber: true,
              address: true,
              locationName: true,
              wardName: true,
              weight: true,
              weightUnit: true,
              noteForDriver: true,
              priceCodPayment: true,
            },
          },
          payments: {
            select: { paymentMethod: true, amount: true },
          },
          details: {
            select: {
              productCode: true,
              productName: true,
              note: true,
              quantity: true,
              price: true,
              discount: true,
              discountRatio: true,
              totalPrice: true,
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        const addr = (inv.customer as any)?.addresses?.[0];

        const payMap = { cash: 0, card: 0, wallet: 0, Transfer: 0 };
        for (const p of inv.payments ?? []) {
          const m = p.paymentMethod ?? 'cash';
          if (m in payMap) payMap[m as keyof typeof payMap] += Number(p.amount);
        }

        let weightGram = 0;
        if (inv.delivery?.weight != null) {
          const w = Number(inv.delivery.weight);
          weightGram = inv.delivery.weightUnit === 'kg' ? w * 1000 : w;
        }

        const codAmount = inv.usingCod
          ? Number(inv.delivery?.priceCodPayment ?? 0)
          : Number(inv.debtAmount);

        const invData: Record<string, any> = {
          branchName: inv.branch?.name ?? '',
          invoiceCode: inv.code,
          purchaseDate: new Date(inv.purchaseDate),
          createdAt: new Date(inv.createdAt),
          updatedAt: new Date(inv.updatedAt),
          orderCode: inv.order?.code ?? '',
          customerCode: inv.customer?.code ?? 'Khách vãng lai',
          customerName: inv.customer?.name ?? 'Khách vãng lai',
          customerGroupName: ((inv.customer as any)?.customerGroupDetails ?? [])
            .map((d: any) => d.customerGroup?.name)
            .filter(Boolean)
            .join(', '),
          customerPhone:
            inv.customer?.contactNumber ?? (inv.customer as any)?.phone ?? '',
          customerAddress: addr?.address ?? '',
          customerLocationName: addr?.locationName ?? '',
          customerWardName: addr?.wardName ?? '',
          priceBookName: inv.priceBookName ?? '',
          soldByName: inv.soldBy?.name ?? '',
          creatorName: inv.creator?.name ?? '',
          deliveryReceiver: inv.delivery?.receiver ?? '',
          deliveryPhone: inv.delivery?.contactNumber ?? '',
          deliveryAddress: inv.delivery?.address ?? '',
          deliveryLocationName: inv.delivery?.locationName ?? '',
          deliveryWardName: inv.delivery?.wardName ?? '',
          deliveryWeight: weightGram,
          deliveryNote: inv.delivery?.noteForDriver ?? '',
          description: inv.description ?? '',
          totalAmount: Number(inv.totalAmount),
          discount: Number(inv.discount),
          grandTotal: Number(inv.grandTotal),
          paidAmount: Number(inv.paidAmount),
          cashPayment: payMap.cash,
          cardPayment: payMap.card,
          walletPayment: payMap.wallet,
          bankTransferPayment: payMap.Transfer,
          rewardPoint: '',
          voucherAmount: '',
          voucherCode: '',
          codAmount,
          statusValue: inv.statusValue ?? '',
        };

        const details = inv.details?.length ? inv.details : [null];

        for (const detail of details) {
          stt++;
          const row: Record<string, any> = { stt };

          for (const col of activeCols) {
            if (col.key in invData) {
              row[col.key] = invData[col.key];
            } else if (detail) {
              switch (col.key) {
                case 'productCode':
                  row[col.key] = detail.productCode;
                  break;
                case 'productName':
                  row[col.key] = detail.productName;
                  break;
                case 'productNote':
                  row[col.key] = detail.note ?? '';
                  break;
                case 'quantity':
                  row[col.key] = Number(detail.quantity);
                  break;
                case 'unitPrice':
                  row[col.key] = Number(detail.price);
                  break;
                case 'detailDiscountRatio':
                  row[col.key] = Number(detail.discountRatio);
                  break;
                case 'detailDiscount':
                  row[col.key] = Number(detail.discount);
                  break;
                case 'sellingPrice':
                  {
                    const qty = Number(detail.quantity);
                    row[col.key] =
                      qty > 0 ? Number(detail.totalPrice) / qty : 0;
                    break;
                  }
                  break;
                case 'totalPrice':
                  row[col.key] = Number(detail.totalPrice);
                  break;
                default:
                  row[col.key] = '';
              }
            } else {
              row[col.key] = '';
            }
          }

          sheet.addRow(row).commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  // ─── EXPORT VAT: Catalog cột chi tiết (1 dòng/sản phẩm, có VAT từng dòng) ───
  getVatDetailColumns(): Array<{ key: string; header: string; width: number }> {
    return [
      { key: 'branchName', header: 'Chi nhánh', width: 18 },
      { key: 'invoiceCode', header: 'Mã hóa đơn', width: 16 },
      { key: 'purchaseDate', header: 'Thời gian', width: 18 },
      { key: 'createdAt', header: 'Thời gian tạo', width: 18 },
      { key: 'updatedAt', header: 'Ngày cập nhật', width: 18 },
      { key: 'orderCode', header: 'Mã đặt hàng', width: 16 },
      { key: 'customerCode', header: 'Mã khách hàng', width: 14 },
      { key: 'customerName', header: 'Tên khách hàng', width: 22 },
      { key: 'customerPhone', header: 'Điện thoại', width: 14 },
      { key: 'customerTaxCode', header: 'Mã số thuế', width: 16 },
      { key: 'customerInvoiceAddress', header: 'Địa chỉ xuất HĐ', width: 28 },
      { key: 'misaEmployeeCode', header: 'Mã NV phụ trách', width: 16 },
      { key: 'misaEmployeeName', header: 'Nhân viên phụ trách', width: 20 },
      { key: 'soldByName', header: 'Người bán', width: 18 },
      { key: 'creatorName', header: 'Người tạo', width: 18 },
      { key: 'description', header: 'Ghi chú', width: 22 },
      { key: 'misaStatusValue', header: 'Trạng thái Misa', width: 16 },
      { key: 'misaOrgRefId', header: 'Mã chứng từ Misa', width: 26 },
      { key: 'misaSyncedAt', header: 'Thời gian đồng bộ', width: 18 },
      { key: 'missingMisaCode', header: 'Thiếu mã Misa', width: 14 },
      { key: 'misaErrorMessage', header: 'Lỗi Misa', width: 30 },
      { key: 'grandTotal', header: 'Tổng HĐ (gốc)', width: 16 },
      { key: 'invoicePreTax', header: 'Tiền trước thuế (HĐ)', width: 18 },
      { key: 'invoiceVat', header: 'Thuế VAT (HĐ)', width: 16 },
      { key: 'invoiceAfterTax', header: 'Tiền sau thuế (HĐ)', width: 18 },
      // ── Cột mức sản phẩm ──
      { key: 'productCode', header: 'Mã hàng', width: 14 },
      { key: 'productName', header: 'Tên hàng', width: 28 },
      { key: 'misaCode', header: 'Mã Misa hàng hóa', width: 18 },
      { key: 'misaUnit', header: 'ĐVT Misa', width: 12 },
      { key: 'productNote', header: 'Ghi chú hàng hóa', width: 22 },
      { key: 'quantity', header: 'Số lượng', width: 12 },
      { key: 'vatRate', header: 'Thuế suất (%)', width: 12 },
      { key: 'unitPriceAfterTax', header: 'Đơn giá sau thuế', width: 16 },
      { key: 'unitPriceBeforeTax', header: 'Đơn giá trước thuế', width: 18 },
      { key: 'linePreTax', header: 'Thành tiền trước thuế', width: 18 },
      { key: 'lineVat', header: 'Tiền thuế VAT', width: 16 },
      { key: 'lineAfterTax', header: 'Thành tiền sau thuế', width: 18 },
    ];
  }

  /** Chuyển status hóa đơn (số) → nhãn trạng thái Misa cho file xuất. */
  private misaStatusLabel(status?: string | null): string {
    switch (status) {
      case 'SYNCED':
        return 'Đã đồng bộ';
      case 'FAILED':
        return 'Thất bại';
      case 'PENDING':
        return 'Chờ xử lý';
      case 'SKIP':
        return 'Bỏ qua';
      default:
        return 'Bỏ qua';
    }
  }

  // ─── EXPORT VAT 1: Tổng quan (1 dòng/hóa đơn, có cột VAT) ───────────────────
  async exportVatOverview(
    query: InvoiceQueryDto,
    res: Response,
  ): Promise<void> {
    const where = await this.buildInvoiceExportWhere(query);
    const BATCH_SIZE = 500;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Hóa đơn VAT tổng quan');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã hóa đơn', key: 'invoiceCode', width: 16 },
      { header: 'Thời gian', key: 'purchaseDate', width: 18 },
      { header: 'Mã khách hàng', key: 'customerCode', width: 14 },
      { header: 'Tên khách hàng', key: 'customerName', width: 22 },
      { header: 'Mã số thuế', key: 'customerTaxCode', width: 16 },
      { header: 'Địa chỉ xuất HĐ', key: 'customerInvoiceAddress', width: 28 },
      { header: 'Nhân viên phụ trách', key: 'misaEmployeeName', width: 20 },
      { header: 'Tiền trước thuế', key: 'invoicePreTax', width: 16 },
      { header: 'Thuế VAT', key: 'invoiceVat', width: 16 },
      { header: 'Tiền sau thuế', key: 'invoiceAfterTax', width: 16 },
      { header: 'Tổng HĐ (gốc)', key: 'grandTotal', width: 16 },
      { header: 'Trạng thái Misa', key: 'misaStatusValue', width: 16 },
      { header: 'Mã chứng từ Misa', key: 'misaOrgRefId', width: 26 },
      { header: 'Thời gian đồng bộ', key: 'misaSyncedAt', width: 18 },
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

    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          grandTotal: true,
          misaSyncStatus: true,
          misaOrgRefId: true,
          misaSyncedAt: true,
          branch: { select: { name: true } },
          customer: {
            select: {
              code: true,
              name: true,
              taxCode: true,
              identificationNumber: true,
              invoiceAddress: true,
              misaEmployeeCode: true,
              misaEmployeeName: true,
            },
          },
          details: {
            select: {
              quantity: true,
              price: true,
              discount: true,
              product: { select: { vat: true } },
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        stt++;
        const vat = computeInvoiceVat(
          (inv.details || []).map((d) => ({
            quantity: d.quantity,
            price: d.price,
            discount: d.discount,
            vatRate: Number((d.product as any)?.vat ?? 8),
          })),
        );
        sheet
          .addRow({
            stt,
            branchName: inv.branch?.name ?? '',
            invoiceCode: inv.code,
            purchaseDate: new Date(inv.purchaseDate),
            customerCode: inv.customer?.code ?? '',
            customerName: inv.customer?.name ?? 'Khách lẻ',
            customerTaxCode:
              inv.customer?.taxCode ?? inv.customer?.identificationNumber ?? '',
            customerInvoiceAddress: inv.customer?.invoiceAddress ?? '',
            misaEmployeeName:
              inv.customer?.misaEmployeeName ??
              inv.customer?.misaEmployeeCode ??
              '',
            invoicePreTax: vat.totalPreTax,
            invoiceVat: vat.totalVat,
            invoiceAfterTax: vat.totalAfterTax,
            grandTotal: Number(inv.grandTotal),
            misaStatusValue: this.misaStatusLabel(inv.misaSyncStatus),
            misaOrgRefId: inv.misaOrgRefId ?? '',
            misaSyncedAt: inv.misaSyncedAt ? new Date(inv.misaSyncedAt) : '',
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  // ─── EXPORT VAT 2: Chi tiết (1 dòng/sản phẩm, VAT từng dòng) ────────────────
  async exportVatDetail(
    query: InvoiceQueryDto,
    selectedColumns: string[],
    res: Response,
  ): Promise<void> {
    const where = await this.buildInvoiceExportWhere(query);
    const BATCH_SIZE = 500;
    const catalog = this.getVatDetailColumns();

    const activeCols =
      selectedColumns.length > 0
        ? catalog.filter((c) => selectedColumns.includes(c.key))
        : catalog;

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Hóa đơn VAT chi tiết');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      ...activeCols.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
      })),
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

    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.invoice.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { purchaseDate: 'desc' },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          createdAt: true,
          updatedAt: true,
          grandTotal: true,
          description: true,
          misaSyncStatus: true,
          misaOrgRefId: true,
          misaSyncedAt: true,
          misaErrorMessage: true,
          branch: { select: { name: true } },
          order: { select: { code: true } },
          customer: {
            select: {
              code: true,
              name: true,
              contactNumber: true,
              phone: true,
              taxCode: true,
              identificationNumber: true,
              invoiceAddress: true,
              misaEmployeeCode: true,
              misaEmployeeName: true,
            },
          },
          soldBy: { select: { name: true } },
          creator: { select: { name: true } },
          details: {
            select: {
              productCode: true,
              productName: true,
              note: true,
              quantity: true,
              price: true,
              discount: true,
              product: {
                select: {
                  vat: true,
                  misa_code: true,
                  misa_unit: true,
                },
              },
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const inv of batch) {
        const lines = (inv.details || []).map((d) => ({
          quantity: d.quantity,
          price: d.price,
          discount: d.discount,
          vatRate: Number((d.product as any)?.vat ?? 8),
        }));
        const invVat = computeInvoiceVat(lines);
        const missingMisaCode = (inv.details || []).some(
          (d) => !d.product?.misa_code || d.product.misa_code.trim() === '',
        );

        const invData: Record<string, any> = {
          branchName: inv.branch?.name ?? '',
          invoiceCode: inv.code,
          purchaseDate: new Date(inv.purchaseDate),
          createdAt: new Date(inv.createdAt),
          updatedAt: new Date(inv.updatedAt),
          orderCode: inv.order?.code ?? '',
          customerCode: inv.customer?.code ?? '',
          customerName: inv.customer?.name ?? 'Khách lẻ',
          customerPhone:
            inv.customer?.contactNumber ?? (inv.customer as any)?.phone ?? '',
          customerTaxCode:
            inv.customer?.taxCode ?? inv.customer?.identificationNumber ?? '',
          customerInvoiceAddress: inv.customer?.invoiceAddress ?? '',
          misaEmployeeCode: inv.customer?.misaEmployeeCode ?? '',
          misaEmployeeName: inv.customer?.misaEmployeeName ?? '',
          soldByName: inv.soldBy?.name ?? '',
          creatorName: inv.creator?.name ?? '',
          description: inv.description ?? '',
          misaStatusValue: this.misaStatusLabel(inv.misaSyncStatus),
          misaOrgRefId: inv.misaOrgRefId ?? '',
          misaSyncedAt: inv.misaSyncedAt ? new Date(inv.misaSyncedAt) : '',
          missingMisaCode: missingMisaCode ? 'Có' : 'Không',
          misaErrorMessage: inv.misaErrorMessage ?? '',
          grandTotal: Number(inv.grandTotal),
          invoicePreTax: invVat.totalPreTax,
          invoiceVat: invVat.totalVat,
          invoiceAfterTax: invVat.totalAfterTax,
        };

        const detailEntries = inv.details?.length ? inv.details : [null];

        for (let i = 0; i < detailEntries.length; i++) {
          const detail = detailEntries[i];
          stt++;
          const row: Record<string, any> = { stt };

          const vatRate = detail
            ? Number((detail.product as any)?.vat ?? 8)
            : 0;
          const lineVat = detail
            ? computeLineVat(
                {
                  quantity: detail.quantity,
                  price: detail.price,
                  discount: detail.discount,
                },
                vatRate,
              )
            : null;

          for (const col of activeCols) {
            if (col.key in invData) {
              row[col.key] = invData[col.key];
            } else if (detail) {
              switch (col.key) {
                case 'productCode':
                  row[col.key] = detail.productCode ?? '';
                  break;
                case 'productName':
                  row[col.key] = detail.productName ?? '';
                  break;
                case 'misaCode':
                  row[col.key] = (detail.product as any)?.misa_code ?? '';
                  break;
                case 'misaUnit':
                  row[col.key] = (detail.product as any)?.misa_unit ?? '';
                  break;
                case 'productNote':
                  row[col.key] = detail.note ?? '';
                  break;
                case 'quantity':
                  row[col.key] = Number(detail.quantity);
                  break;
                case 'vatRate':
                  row[col.key] = vatRate;
                  break;
                case 'unitPriceAfterTax':
                  row[col.key] = lineVat?.unitPriceAfterTax ?? 0;
                  break;
                case 'unitPriceBeforeTax':
                  row[col.key] = lineVat?.unitPrice ?? 0;
                  break;
                case 'linePreTax':
                  row[col.key] = lineVat?.amountBeforeTax ?? 0;
                  break;
                case 'lineVat':
                  row[col.key] = lineVat?.vatAmount ?? 0;
                  break;
                case 'lineAfterTax':
                  row[col.key] = lineVat?.amountAfterTax ?? 0;
                  break;
                default:
                  row[col.key] = '';
              }
            } else {
              row[col.key] = '';
            }
          }

          sheet.addRow(row).commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }
}
