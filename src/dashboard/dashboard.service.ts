import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type RangeKey =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'lastMonth'
  | 'custom';
// Mốc thời gian của So sánh chi nhánh (khớp PeriodKey phía frontend).
export type PeriodKey =
  | 'today'
  | 'yesterday'
  | 'd7'
  | 'd30'
  | 'thisWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';
/** Khoảng ngày người dùng tự chọn (range/period = 'custom'). */
export interface CustomRange {
  from: Date;
  to: Date;
}
export type TopMetric = 'rev' | 'qty' | 'profit';
export type CategoryDimension = 'parent' | 'middle' | 'child';

interface RangeWindow {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
}

// Trạng thái hóa đơn (đồng bộ invoices/dto/invoice-status.constants.ts):
// 1 Hoàn thành · 2 Đã hủy · 3 Đang xử lý · 4 Không giao được ·
// 5 Đóng hàng · 6 Lấy hàng · 7 Giao thành công · 8 Trả hàng
// Doanh thu: loại Đã hủy (2) + Trả hàng (8).
const REVENUE_EXCLUDE = [2, 8];
// COD cần giao: loại Hoàn thành (1), Đã hủy (2), Giao thành công (7).
const COD_DONE_OR_CANCELLED = [1, 2, 7];
// Worklist (Tổng quan) chỉ tính 3 chi nhánh đang vận hành khi không lọc cụ thể:
// 1 Kho Sài Gòn · 5 Văn phòng Hà Nội · 6 Kho Hà Nội.
const TASK_BRANCH_IDS = [1, 5, 6];
// Tab "Tồn cảnh báo" chỉ theo dõi các loại hàng này (products.parent_name).
const STOCK_WARNING_PARENT_NAMES = ['Hàng thương hiệu', 'Hàng thương mại'];

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  // ───────────────────────────── Helpers ─────────────────────────────

  /**
   * Tính khoảng thời gian hiện tại + kỳ trước để so sánh delta.
   * today  → từ 00:00 hôm nay; kỳ trước = hôm qua.
   * week   → 7 ngày gần nhất; kỳ trước = 7 ngày liền trước.
   * month  → từ đầu tháng; kỳ trước = tháng trước (cùng số ngày trôi qua).
   */
  private getRangeWindow(range: RangeKey, custom?: CustomRange): RangeWindow {
    const now = new Date();
    if (range === 'custom' && custom) {
      // Kỳ trước = khoảng liền trước có cùng độ dài.
      const span = custom.to.getTime() - custom.from.getTime();
      const prevEnd = new Date(custom.from.getTime() - 1);
      const prevStart = new Date(prevEnd.getTime() - span);
      return { start: custom.from, end: custom.to, prevStart, prevEnd };
    }
    if (range === 'lastMonth') {
      // Trọn tháng trước; kỳ trước = trọn tháng liền trước nữa.
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      end.setMilliseconds(-1);
      const prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const prevEnd = new Date(start.getTime() - 1);
      return { start, end, prevStart, prevEnd };
    }
    if (range === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 1);
      return { start, end: now, prevStart, prevEnd: start };
    }
    if (range === 'yesterday') {
      const start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      const prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 1);
      return { start, end, prevStart, prevEnd: start };
    }
    if (range === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 7);
      return { start, end: now, prevStart, prevEnd: start };
    }
    // month — so cùng kỳ MTD: cùng thời lượng đã trôi qua của tháng trước
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const elapsed = now.getTime() - start.getTime();
    const prevEnd = new Date(prevStart.getTime() + elapsed);
    return { start, end: now, prevStart, prevEnd };
  }

  /** Khoảng thời gian [start, end] cho các mốc PeriodKey. */
  private getPeriodWindow(
    period: PeriodKey,
    custom?: CustomRange,
  ): { start: Date; end: Date } {
    const now = new Date();
    if (period === 'custom' && custom) {
      return { start: custom.from, end: custom.to };
    }
    switch (period) {
      case 'today':
      case 'yesterday':
        return this.getRangeWindow(period);
      case 'd7':
        return this.getRangeWindow('week');
      case 'thisMonth':
        return this.getRangeWindow('month');
      case 'd30': {
        const start = new Date(now);
        start.setDate(start.getDate() - 29);
        start.setHours(0, 0, 0, 0);
        return { start, end: now };
      }
      case 'thisWeek': {
        // Tuần bắt đầu từ thứ Hai.
        const start = new Date(now);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        start.setHours(0, 0, 0, 0);
        return { start, end: now };
      }
      case 'lastMonth': {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 1);
        end.setMilliseconds(-1);
        return { start, end };
      }
      default:
        return this.getRangeWindow('week');
    }
  }

  /** Độ dài khoảng (ngày) — dùng chọn mức gom nhóm cho khoảng tùy chọn. */
  private spanDays(start: Date, end: Date): number {
    return (end.getTime() - start.getTime()) / 86400000;
  }

  /** where clause chung cho Order, có lọc branch nếu truyền. */
  private orderWhere(
    window: { gte: Date; lt?: Date },
    branchId?: number,
  ): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {
      orderDate: window.lt
        ? { gte: window.gte, lt: window.lt }
        : { gte: window.gte },
      orderStatus: { not: 'cancelled' },
    };
    if (branchId) where.branchId = branchId;
    return where;
  }

  /**
   * where clause chung cho Invoice (hóa đơn) — nền tảng ghi nhận doanh thu.
   * Loại trừ hóa đơn Đã hủy + Trả hàng. Lọc branch nếu truyền.
   */
  private invoiceWhere(
    window: { gte: Date; lt?: Date },
    branchId?: number,
  ): Prisma.InvoiceWhereInput {
    const where: Prisma.InvoiceWhereInput = {
      purchaseDate: window.lt
        ? { gte: window.gte, lt: window.lt }
        : { gte: window.gte },
      status: { notIn: REVENUE_EXCLUDE },
    };
    if (branchId) where.branchId = branchId;
    return where;
  }

  private pct(curr: number, prev: number): number {
    if (prev <= 0) return 0;
    return Number((((curr - prev) / prev) * 100).toFixed(2));
  }

  /**
   * Giá vốn (COGS) ước tính cho các hóa đơn trong khoảng: SUM(quantity × inventory.cost),
   * khớp theo productId + branchId (LEFT JOIN — dòng thiếu giá vốn tính = 0 để không
   * lệch số dòng so với doanh thu), chỉ chi nhánh đang hoạt động.
   * InvoiceDetail không lưu giá vốn theo dòng nên đây là số tạm tính theo giá vốn hiện tại.
   */
  private async estimateCogs(
    start: Date,
    end: Date,
    branchId?: number,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<[{ cogs: number | null }]>`
      SELECT COALESCE(SUM(id.quantity * COALESCE(inv.cost, 0)), 0)::float8 AS cogs
      FROM invoice_details id
      INNER JOIN invoices i ON id."invoiceId" = i.id
      INNER JOIN branches b ON b.id = i."branchId" AND b."isActive" = true
      LEFT JOIN inventories inv ON inv."productId" = id."productId" AND inv."branchId" = i."branchId"
      WHERE i."purchaseDate" >= ${start}
        AND i."purchaseDate" <= ${end}
        AND i.status NOT IN (2, 8)
        ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
    `;
    return Number(rows[0]?.cogs || 0);
  }

  // ──────────────────────────── KPI Overview ────────────────────────────

  async getStatsOverview(
    range: RangeKey = 'month',
    branchId?: number,
    custom?: CustomRange,
  ) {
    try {
      const w = this.getRangeWindow(range, custom);
      const branchFilter = branchId
        ? Prisma.sql`AND i."branchId" = ${branchId}`
        : Prisma.empty;

      const [
        currentRevenue,
        lastRevenue,
        currentOrders,
        lastOrders,
        totalCustomerDebt,
        totalSupplierDebt,
        lowStockResult,
        outOfStockResult,
        negativeStockResult,
        unpaidResult,
        codResult,
        currCogs,
        prevCogs,
      ] = await Promise.all([
        this.prisma.invoice.aggregate({
          where: this.invoiceWhere({ gte: w.start, lt: w.end }, branchId),
          _sum: { grandTotal: true },
        }),
        this.prisma.invoice.aggregate({
          where: this.invoiceWhere(
            { gte: w.prevStart, lt: w.prevEnd },
            branchId,
          ),
          _sum: { grandTotal: true },
        }),
        this.prisma.invoice.count({
          where: this.invoiceWhere({ gte: w.start, lt: w.end }, branchId),
        }),
        this.prisma.invoice.count({
          where: this.invoiceWhere(
            { gte: w.prevStart, lt: w.prevEnd },
            branchId,
          ),
        }),
        this.prisma.customer.aggregate({
          where: { isActive: true, ...(branchId ? { branchId } : {}) },
          _sum: { totalDebt: true },
        }),
        this.prisma.supplier.aggregate({
          where: { isActive: true, ...(branchId ? { branchId } : {}) },
          _sum: { debt: true },
        }),
        this.prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(DISTINCT i."productId") as count
          FROM inventories i
          INNER JOIN products p ON i."productId" = p.id
          INNER JOIN branches b ON i."branchId" = b.id AND b."isActive" = true
          WHERE p."isActive" = true
          AND i."onHand" > 0
          AND i."onHand" <= i."minQuality"
          ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
        `,
        this.prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(DISTINCT i."productId") as count
          FROM inventories i
          INNER JOIN products p ON i."productId" = p.id
          INNER JOIN branches b ON i."branchId" = b.id AND b."isActive" = true
          WHERE p."isActive" = true
          AND i."onHand" = 0
          ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
        `,
        this.prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(DISTINCT i."productId") as count
          FROM inventories i
          INNER JOIN products p ON i."productId" = p.id
          INNER JOIN branches b ON i."branchId" = b.id AND b."isActive" = true
          WHERE p."isActive" = true
          AND i."onHand" < 0
          ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
        `,
        // HĐ còn phải thu — theo khoảng thời gian đã chọn (purchaseDate),
        // chỉ khách hàng còn hoạt động, HĐ chưa hủy.
        this.prisma.invoice.aggregate({
          where: {
            debtAmount: { gt: 0 },
            status: { notIn: [2] },
            customer: { is: { isActive: true } },
            purchaseDate: { gte: w.start, lte: w.end },
            ...(branchId ? { branchId } : {}),
          },
          _sum: { debtAmount: true },
          _count: true,
        }),
        // COD đang luân chuyển theo Hóa đơn — loại HĐ đã Hoàn thành/Hủy/Giao thành công.
        this.prisma.$queryRaw<[{ amount: number | null; cnt: bigint }]>`
          SELECT COALESCE(SUM(i."grandTotal" - i."paidAmount"), 0)::float8 AS amount,
                 COUNT(*)::bigint AS cnt
          FROM invoices i
          WHERE i."usingCod" = true
            AND i.status NOT IN (1, 2, 7)
            ${branchFilter}
        `,
        this.estimateCogs(w.start, w.end, branchId),
        this.estimateCogs(w.prevStart, w.prevEnd, branchId),
      ]);

      const currentRevenueNum = Number(currentRevenue._sum.grandTotal || 0);
      const lastRevenueNum = Number(lastRevenue._sum.grandTotal || 0);
      const profit = currentRevenueNum - currCogs;
      const prevProfit = lastRevenueNum - prevCogs;
      const marginAvg = currentRevenueNum > 0 ? profit / currentRevenueNum : 0;
      const codAmount = Number(codResult[0]?.amount || 0);
      const codCount = Number(codResult[0]?.cnt || 0);

      return {
        range,
        currentRevenue: currentRevenueNum,
        lastRevenue: lastRevenueNum,
        revenueChange: this.pct(currentRevenueNum, lastRevenueNum),
        currentMonthOrders: currentOrders,
        invoiceCount: currentOrders,
        invoiceChange: this.pct(currentOrders, lastOrders),
        aov: currentOrders > 0 ? currentRevenueNum / currentOrders : 0,
        aovChange: this.pct(
          currentOrders > 0 ? currentRevenueNum / currentOrders : 0,
          lastOrders > 0 ? lastRevenueNum / lastOrders : 0,
        ),
        profit,
        profitChange: this.pct(profit, prevProfit),
        marginAvg: Number(marginAvg.toFixed(4)),
        totalCustomerDebt: Number(totalCustomerDebt._sum.totalDebt || 0),
        totalSupplierDebt: Number(totalSupplierDebt._sum.debt || 0),
        unpaidInvoices: unpaidResult._count || 0,
        unpaidAmount: Number(unpaidResult._sum.debtAmount || 0),
        codAmount,
        codCount,
        lowStockProducts: Number(lowStockResult[0].count),
        outOfStockProducts: Number(outOfStockResult[0].count),
        negativeStock: Number(negativeStockResult[0].count),
      };
    } catch (error) {
      throw error;
    }
  }

  async getRevenueChart(months: number = 6) {
    const now = new Date();
    const chartData: any[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextMonthDate = new Date(
        now.getFullYear(),
        now.getMonth() - i + 1,
        1,
      );

      const revenue = await this.prisma.order
        .aggregate({
          where: {
            orderDate: {
              gte: monthDate,
              lt: nextMonthDate,
            },
            orderStatus: { not: 'cancelled' },
          },
          _sum: { grandTotal: true },
        })
        .catch(() => ({ _sum: { grandTotal: 0 } }));

      chartData.push({
        month: monthDate.toLocaleDateString('vi-VN', {
          month: '2-digit',
          year: 'numeric',
        }),
        revenue: Number(revenue._sum.grandTotal || 0),
      });
    }

    return chartData;
  }

  /**
   * Top khách mua nhiều nhất trong khoảng thời gian — theo tổng tiền hóa đơn
   * (loại Đã hủy + Trả hàng, cùng chuẩn doanh thu dashboard). Bỏ khách vãng lai.
   */
  async getTopBuyers(
    limit: number = 10,
    range: RangeKey = 'month',
    branchId?: number,
    custom?: CustomRange,
  ) {
    const w = this.getRangeWindow(range, custom);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.id,
        c.code,
        c.name,
        SUM(i."grandTotal")::float8 AS "totalRevenue",
        COUNT(*)::int AS "invoiceCount"
      FROM invoices i
      INNER JOIN customers c ON c.id = i."customerId"
      WHERE i."purchaseDate" >= ${w.start}
        AND i."purchaseDate" <= ${w.end}
        AND i.status NOT IN (2, 8)
        ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
      GROUP BY c.id, c.code, c.name
      ORDER BY "totalRevenue" DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      totalRevenue: Number(r.totalRevenue || 0),
      invoiceCount: Number(r.invoiceCount || 0),
    }));
  }

  async getTopCustomers(limit: number = 10) {
    const customers = await this.prisma.customer
      .findMany({
        where: {
          isActive: true,
        },
        orderBy: {
          totalPurchased: 'desc',
        },
        take: limit,
        include: {
          customerType: true,
          _count: {
            select: { orders: true },
          },
        },
      })
      .catch(() => []);

    return customers.map((customer) => ({
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: customer.phone,
      totalPurchased: customer.totalPurchased,
      totalDebt: customer.totalDebt,
      orderCount: customer._count.orders,
      customerType: customer.customerType?.name,
    }));
  }

  async getLowStockProducts(limit: number = 20) {
    const inventories = await this.prisma.$queryRaw<any[]>`
    SELECT 
      i.id,
      i."productId",
      i."branchId",
      i."onHand",
      i."minQuality",
      i."maxQuality",
      p.code as "productCode",
      p.name as "productName",
      p."basePrice",
      p.unit,
      b.name as "branchName"
    FROM inventories i
    INNER JOIN products p ON i."productId" = p.id
    INNER JOIN branches b ON i."branchId" = b.id
    WHERE p."isActive" = true
    AND i."onHand" <= i."minQuality"
    ORDER BY i."onHand" ASC
    LIMIT ${limit}
  `;

    return inventories.map((inv) => ({
      id: inv.id,
      productId: inv.productId,
      productCode: inv.productCode,
      productName: inv.productName,
      branchId: inv.branchId,
      branchName: inv.branchName,
      onHand: Number(inv.onHand),
      minQuality: Number(inv.minQuality),
      maxQuality: Number(inv.maxQuality),
      basePrice: Number(inv.basePrice),
      unit: inv.unit,
    }));
  }

  async getRecentOrders(limit: number = 10) {
    const orders = await this.prisma.order.findMany({
      where: { orderStatus: { not: 'cancelled' } },
      take: limit,
      orderBy: { orderDate: 'desc' },
      include: {
        customer: { select: { name: true, code: true } },
      },
    });

    return orders.map((order) => ({
      id: order.id,
      code: order.code,
      customerName: order.customer?.name || 'Khách vãng lai',
      orderDate: order.orderDate,
      grandTotal: Number(order.grandTotal),
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
    }));
  }

  // ======== THÊM MỚI: 3 methods bên dưới ========

  async getTodayStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayRevenue, todayOrders, todayReturns, todayInvoices] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: {
            orderDate: { gte: today },
            orderStatus: { not: 'cancelled' },
          },
          _sum: { grandTotal: true },
        }),
        this.prisma.order.count({
          where: {
            orderDate: { gte: today },
            orderStatus: { not: 'cancelled' },
          },
        }),
        this.prisma.returnOrder.aggregate({
          where: {
            createdAt: { gte: today },
            status: { not: 0 },
          },
          _sum: { refundAmount: true },
          _count: true,
        }),
        this.prisma.invoice.aggregate({
          where: {
            purchaseDate: { gte: today },
            status: { not: 0 },
          },
          _sum: { grandTotal: true },
          _count: true,
        }),
      ]);

    const revenue = Number(todayRevenue._sum.grandTotal || 0);
    const returns = Number(todayReturns._sum.refundAmount || 0);
    const invoiceRevenue = Number(todayInvoices._sum.grandTotal || 0);

    return {
      todayRevenue: revenue,
      todayOrders,
      todayReturns: returns,
      todayReturnCount: todayReturns._count || 0,
      todayNetRevenue: revenue - returns,
      todayInvoiceRevenue: invoiceRevenue,
      todayInvoiceCount: todayInvoices._count || 0,
    };
  }

  async getTopProducts(
    limit: number = 10,
    range: RangeKey = 'month',
    branchId?: number,
    metric: TopMetric = 'rev',
    dimension?: CategoryDimension,
    categoryValue?: string,
    custom?: CustomRange,
  ) {
    const w = this.getRangeWindow(range, custom);
    const branchFilter = branchId
      ? Prisma.sql`AND i."branchId" = ${branchId}`
      : Prisma.empty;

    // Lọc theo nhóm hàng (parent/middle/child) nếu có truyền.
    const dimCol =
      dimension === 'parent'
        ? Prisma.sql`p."parent_name"`
        : dimension === 'middle'
          ? Prisma.sql`p."middle_name"`
          : dimension === 'child'
            ? Prisma.sql`p."child_name"`
            : null;
    const catFilter =
      dimCol && categoryValue
        ? Prisma.sql`AND ${dimCol} = ${categoryValue}`
        : Prisma.empty;

    const orderCol =
      metric === 'qty'
        ? Prisma.sql`SUM(d.quantity)`
        : metric === 'profit'
          ? Prisma.sql`SUM(d."totalPrice" - d.quantity * COALESCE(inv.cost, 0))`
          : Prisma.sql`SUM(d."totalPrice")`;

    const products = await this.prisma.$queryRaw<any[]>`
      SELECT
        d."productId",
        d."productCode",
        d."productName",
        SUM(d.quantity)::float8     AS "totalQuantity",
        SUM(d."totalPrice")::float8 AS "totalRevenue",
        SUM(d."totalPrice" - d.quantity * COALESCE(inv.cost, 0))::float8 AS "totalProfit"
      FROM invoice_details d
      INNER JOIN invoices i ON d."invoiceId" = i.id
      INNER JOIN products p ON p.id = d."productId"
      LEFT JOIN inventories inv ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
      WHERE i."purchaseDate" >= ${w.start}
        AND i."purchaseDate" <= ${w.end}
        AND i.status NOT IN (2, 8)
        ${branchFilter}
        ${catFilter}
      GROUP BY d."productId", d."productCode", d."productName"
      ORDER BY ${orderCol} DESC
      LIMIT ${limit}
    `;

    return products.map((p) => ({
      productId: Number(p.productId),
      code: p.productCode,
      name: p.productName,
      totalQuantity: Number(p.totalQuantity),
      totalRevenue: Number(p.totalRevenue),
      totalProfit: Number(p.totalProfit),
    }));
  }

  // ─────────────────────── Revenue / Profit trend ───────────────────────

  /**
   * Series doanh thu + lợi nhuận (tạm tính) theo trục thời gian.
   * today → theo giờ; week → theo ngày; month → theo tuần ISO.
   */
  async getRevenueTrend(
    range: RangeKey = 'today',
    branchId?: number,
    custom?: CustomRange,
  ) {
    const w = this.getRangeWindow(range, custom);
    const branchFilter = branchId
      ? Prisma.sql`AND i."branchId" = ${branchId}`
      : Prisma.empty;

    // today/yesterday → theo giờ; week/month/lastMonth → theo ngày.
    // custom: ≤ 1 ngày → giờ, ≤ 92 ngày → ngày, dài hơn → tháng.
    let trunc: 'hour' | 'day' | 'month' =
      range === 'today' || range === 'yesterday' ? 'hour' : 'day';
    if (range === 'custom') {
      const days = this.spanDays(w.start, w.end);
      trunc = days <= 1 ? 'hour' : days <= 92 ? 'day' : 'month';
    }

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc(${trunc}, i."purchaseDate") AS bucket,
        SUM(i."grandTotal")::float8 AS revenue,
        COALESCE(SUM(li.cogs), 0)::float8 AS cogs
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT SUM(d.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM invoice_details d
        LEFT JOIN inventories inv
          ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
        WHERE d."invoiceId" = i.id
      ) li ON true
      WHERE i."purchaseDate" >= ${w.start}
        AND i."purchaseDate" <= ${w.end}
        AND i.status NOT IN (2, 8)
        ${branchFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const fmt = (d: Date): string => {
      const dt = new Date(d);
      if (trunc === 'hour') return String(dt.getHours()).padStart(2, '0');
      if (trunc === 'month') {
        return `${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
      }
      if (range === 'week') {
        return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dt.getDay()];
      }
      // month → theo ngày: dd/MM
      return `${String(dt.getDate()).padStart(2, '0')}/${String(
        dt.getMonth() + 1,
      ).padStart(2, '0')}`;
    };

    return rows.map((r) => {
      const revenue = Number(r.revenue || 0);
      const profit = revenue - Number(r.cogs || 0);
      return { label: fmt(r.bucket), revenue, profit };
    });
  }

  // ───────────────────── Category breakdown (nhóm hàng) ─────────────────────

  async getCategoryBreakdown(
    range: RangeKey = 'month',
    branchId?: number,
    dimension: CategoryDimension = 'parent',
    custom?: CustomRange,
  ) {
    const w = this.getRangeWindow(range, custom);
    const branchFilter = branchId
      ? Prisma.sql`AND i."branchId" = ${branchId}`
      : Prisma.empty;
    const dimCol =
      dimension === 'middle'
        ? Prisma.sql`p."middle_name"`
        : dimension === 'child'
          ? Prisma.sql`p."child_name"`
          : Prisma.sql`p."parent_name"`;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(NULLIF(${dimCol}, ''), 'Khác') AS name,
        SUM(d."totalPrice")::float8 AS revenue
      FROM invoice_details d
      INNER JOIN invoices i ON d."invoiceId" = i.id
      INNER JOIN products p ON p.id = d."productId"
      WHERE i."purchaseDate" >= ${w.start}
        AND i."purchaseDate" <= ${w.end}
        AND i.status NOT IN (2, 8)
        ${branchFilter}
      GROUP BY COALESCE(NULLIF(${dimCol}, ''), 'Khác')
      ORDER BY revenue DESC
    `;

    const total = rows.reduce((s, r) => s + Number(r.revenue || 0), 0) || 1;
    return rows.map((r) => ({
      name: r.name,
      revenue: Number(r.revenue || 0),
      percent: Number(((Number(r.revenue || 0) / total) * 100).toFixed(1)),
    }));
  }

  // ──────────────────────── Branch comparison ────────────────────────

  /**
   * So sánh các chi nhánh đang hoạt động theo trục thời gian (stacked bar).
   * Trả { labels, branches: [{ id, name, data[] }] }.
   */
  async getBranchComparison(
    period: PeriodKey = 'd7',
    metric: 'rev' | 'profit' = 'rev',
    custom?: CustomRange,
  ) {
    const w = this.getPeriodWindow(period, custom);
    let trunc: 'hour' | 'day' | 'week' | 'month' =
      period === 'today' || period === 'yesterday'
        ? 'hour'
        : period === 'd7' || period === 'thisWeek'
          ? 'day'
          : 'week';
    if (period === 'custom') {
      // custom: ≤ 1 ngày → giờ, ≤ 14 ngày → ngày, ≤ 92 ngày → tuần, dài hơn → tháng.
      const days = this.spanDays(w.start, w.end);
      trunc =
        days <= 1 ? 'hour' : days <= 14 ? 'day' : days <= 92 ? 'week' : 'month';
    }

    const valueCol =
      metric === 'profit'
        ? Prisma.sql`SUM(i."grandTotal") - COALESCE(SUM(li.cogs), 0)`
        : Prisma.sql`SUM(i."grandTotal")`;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        i."branchId" AS "branchId",
        b.name AS "branchName",
        date_trunc(${trunc}, i."purchaseDate") AS bucket,
        ${valueCol}::float8 AS value
      FROM invoices i
      INNER JOIN branches b ON b.id = i."branchId" AND b."isActive" = true
      LEFT JOIN LATERAL (
        SELECT SUM(d.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM invoice_details d
        LEFT JOIN inventories inv
          ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
        WHERE d."invoiceId" = i.id
      ) li ON true
      WHERE i."purchaseDate" >= ${w.start}
        AND i."purchaseDate" <= ${w.end}
        AND i.status NOT IN (2, 8)
      GROUP BY i."branchId", b.name, bucket
      ORDER BY bucket ASC
    `;

    const fmt = (d: Date): string => {
      const dt = new Date(d);
      if (trunc === 'hour') return String(dt.getHours()).padStart(2, '0');
      if (trunc === 'month') {
        return `${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
      }
      // Khoảng tùy chọn có thể dài hơn 1 tuần → nhãn ngày dd/MM để không trùng thứ.
      if (trunc === 'day' && period !== 'custom') {
        return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dt.getDay()];
      }
      // Bucket tuần: nhãn = ngày thứ Hai đầu tuần (dd/MM) — tránh trùng nhãn
      // khi khoảng thời gian vắt qua 2 tháng (vd 30 ngày).
      return `${String(dt.getDate()).padStart(2, '0')}/${String(
        dt.getMonth() + 1,
      ).padStart(2, '0')}`;
    };

    const labelSet: string[] = [];
    const branchMap = new Map<
      number,
      { id: number; name: string; map: Map<string, number> }
    >();
    for (const r of rows) {
      const label = fmt(r.bucket);
      if (!labelSet.includes(label)) labelSet.push(label);
      const id = Number(r.branchId);
      if (!branchMap.has(id)) {
        branchMap.set(id, { id, name: r.branchName, map: new Map() });
      }
      branchMap.get(id)!.map.set(label, Number(r.value || 0));
    }

    const branches = [...branchMap.values()].map((b) => ({
      id: b.id,
      name: b.name,
      data: labelSet.map((l) => b.map.get(l) || 0),
      total: labelSet.reduce((s, l) => s + (b.map.get(l) || 0), 0),
    }));

    return { labels: labelSet, branches };
  }

  // ──────────────────────── Finance (công nợ & COD & aging) ────────────────────────

  /**
   * Công nợ & COD. Tổng phải thu khớp trang Khách hàng (Σ Nợ hiện tại của khách
   * đang hoạt động). Phân tuổi nợ: với mỗi khách còn nợ, tiền đã trả coi như trừ
   * HĐ cũ nhất trước → phần nợ thực nằm ở các HĐ mới nhất (debtAmount trên HĐ
   * không phản ánh các khoản thu nợ chung / ứng trước / cấn trừ chưa gắn HĐ).
   * Nợ không gắn HĐ nào (vd số dư đầu kỳ) tính vào nhóm > 30 ngày.
   */
  async getFinance(
    period: PeriodKey | 'all' = 'all',
    branchId?: number,
    custom?: CustomRange,
  ) {
    const w = period === 'all' ? null : this.getPeriodWindow(period, custom);
    const filtered = !!branchId || !!w;

    const branchFilter = branchId
      ? Prisma.sql`AND i."branchId" = ${branchId}`
      : Prisma.empty;
    const windowFilter = w
      ? Prisma.sql`AND i."purchaseDate" >= ${w.start} AND i."purchaseDate" <= ${w.end}`
      : Prisma.empty;

    const [customerDebt, codResult, agingRows] = await Promise.all([
      this.prisma.customer.aggregate({
        where: { isActive: true },
        _sum: { totalDebt: true },
      }),
      // COD đang luân chuyển theo Hóa đơn — loại HĐ Hoàn thành/Hủy/Giao thành công.
      this.prisma.$queryRaw<[{ amount: number | null; cnt: bigint }]>`
        SELECT COALESCE(SUM(i."grandTotal" - i."paidAmount"), 0)::float8 AS amount,
               COUNT(*)::bigint AS cnt
        FROM invoices i
        WHERE i."usingCod" = true
          AND i.status NOT IN (1, 2, 7)
          ${branchFilter}
          ${windowFilter}
      `,
      this.prisma.$queryRaw<
        [
          {
            in_term: number;
            d30: number;
            over30: number;
            allocated: number;
            cnt: number;
            leftover: number;
          },
        ]
      >`
        WITH cust AS (
          SELECT id, "totalDebt" AS td
          FROM customers
          WHERE "isActive" = true AND "totalDebt" > 0
        ),
        inv AS (
          SELECT i.id, i."customerId" AS cid, i."branchId", i."purchaseDate",
                 i."debtAmount" AS d,
                 SUM(i."debtAmount") OVER (
                   PARTITION BY i."customerId"
                   ORDER BY i."purchaseDate" DESC, i.id DESC
                 ) AS cum
          FROM invoices i
          INNER JOIN cust c ON c.id = i."customerId"
          WHERE i."debtAmount" > 0 AND i.status NOT IN (2)
        ),
        alloc AS (
          SELECT inv.*, GREATEST(0, LEAST(inv.d, c.td - (inv.cum - inv.d))) AS a
          FROM inv
          INNER JOIN cust c ON c.id = inv.cid
        ),
        leftover AS (
          SELECT COALESCE(SUM(GREATEST(0, c.td - COALESCE(s.total, 0))), 0) AS amt
          FROM cust c
          LEFT JOIN (SELECT cid, SUM(d) AS total FROM inv GROUP BY cid) s
            ON s.cid = c.id
        )
        SELECT
          COALESCE(SUM(i.a) FILTER (WHERE (now()::date - i."purchaseDate"::date) <= 0), 0)::float8 AS in_term,
          COALESCE(SUM(i.a) FILTER (WHERE (now()::date - i."purchaseDate"::date) BETWEEN 1 AND 30), 0)::float8 AS d30,
          COALESCE(SUM(i.a) FILTER (WHERE (now()::date - i."purchaseDate"::date) > 30), 0)::float8 AS over30,
          COALESCE(SUM(i.a), 0)::float8 AS allocated,
          COUNT(*)::int AS cnt,
          (SELECT amt FROM leftover)::float8 AS leftover
        FROM alloc i
        WHERE i.a > 0
          ${branchFilter}
          ${windowFilter}
      `,
    ]);

    const row = agingRows[0];
    // Nợ không gắn HĐ chỉ có ý nghĩa khi xem toàn bộ (không lọc CN/thời gian).
    const leftover = filtered ? 0 : Number(row?.leftover || 0);
    const aging = {
      inTerm: Number(row?.in_term || 0),
      d1to30: Number(row?.d30 || 0),
      over30: Number(row?.over30 || 0) + leftover,
    };
    const debt = filtered
      ? Number(row?.allocated || 0)
      : Number(customerDebt._sum.totalDebt || 0);

    return {
      finRange: period,
      debt,
      overdue: aging.d1to30 + aging.over30,
      unpaidCount: Number(row?.cnt || 0),
      codAmount: Number(codResult[0]?.amount || 0),
      codCount: Number(codResult[0]?.cnt || 0),
      aging,
    };
  }

  // ──────────────────────── Tasks (việc cần xử lý) ────────────────────────

  async getTasks(
    type: 'orders' | 'debt' | 'cod' | 'stock' = 'orders',
    branchId?: number,
    limit: number = 20,
    status?: string,
  ) {
    if (type === 'orders') {
      const orders = await this.prisma.order.findMany({
        where: {
          // Chỉ đơn cần xử lý: phiếu tạm / đã xác nhận / đã ra 1 phần HĐ.
          // Loại đã hủy + hoàn thành. Nếu lọc status cụ thể thì chỉ nhận
          // các trạng thái hợp lệ trong nhóm cần xử lý.
          orderStatus:
            status &&
            ['pending', 'confirmed', 'partially_invoiced'].includes(status)
              ? status
              : { in: ['pending', 'confirmed', 'partially_invoiced'] },
          // Chỉ khách đang hoạt động (loại vãng lai + KH ngừng hoạt động).
          customer: { is: { isActive: true } },
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
        take: limit,
        orderBy: { orderDate: 'desc' },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      return orders.map((o) => ({
        code: o.code,
        partner: o.customer?.name || 'Khách vãng lai',
        branchName: o.branch?.name || '',
        value: Number(o.grandTotal),
        time: o.orderDate,
        status: o.orderStatus,
        paymentStatus: o.paymentStatus,
        usingCod: o.usingCod,
      }));
    }

    if (type === 'debt') {
      // Công nợ đến hạn theo Hóa đơn — khách còn hoạt động, HĐ chưa hủy.
      // Lọc theo tuổi nợ (status): in_term | due | overdue.
      const now = new Date();
      const startToday = new Date(now);
      startToday.setHours(0, 0, 0, 0);
      const d30 = new Date(startToday);
      d30.setDate(d30.getDate() - 30);
      let ageFilter: Prisma.InvoiceWhereInput = {};
      if (status === 'in_term') {
        ageFilter = { purchaseDate: { gte: startToday } };
      } else if (status === 'due') {
        ageFilter = { purchaseDate: { gte: d30, lt: startToday } };
      } else if (status === 'overdue') {
        ageFilter = { purchaseDate: { lt: d30 } };
      }
      const invoices = await this.prisma.invoice.findMany({
        where: {
          debtAmount: { gt: 0 },
          status: { notIn: [2] },
          customer: { is: { isActive: true } },
          ...ageFilter,
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
        take: limit,
        orderBy: { purchaseDate: 'asc' },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      return invoices.map((inv) => {
        const ageDays = Math.floor(
          (Date.now() - new Date(inv.purchaseDate).getTime()) / 86400000,
        );
        return {
          code: inv.code,
          partner: inv.customer?.name || inv.customerName || 'Khách vãng lai',
          branchName: inv.branch?.name || '',
          value: Number(inv.debtAmount),
          ageDays,
          time: inv.purchaseDate,
          status: ageDays > 30 ? 'overdue' : ageDays > 0 ? 'due' : 'in_term',
        };
      });
    }

    if (type === 'cod') {
      // Cần giao (COD) theo Hóa đơn — loại HĐ Hoàn thành/Hủy/Giao thành công.
      // Lọc theo trạng thái HĐ cụ thể (status = số 3/4/5/6/8) nếu hợp lệ.
      const codStatuses = [3, 4, 5, 6, 8];
      const wantStatus = status ? Number(status) : NaN;
      const statusFilter =
        !isNaN(wantStatus) && codStatuses.includes(wantStatus)
          ? wantStatus
          : { notIn: [1, 2, 7] };
      const invoices = await this.prisma.invoice.findMany({
        where: {
          usingCod: true,
          status: statusFilter,
          customer: { is: { isActive: true } },
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
        take: limit,
        orderBy: { purchaseDate: 'desc' },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
          delivery: { select: { status: true, statusValue: true } },
        },
      });
      return invoices.map((inv) => ({
        code: inv.code,
        partner: inv.customer?.name || inv.customerName || 'Khách vãng lai',
        branchName: inv.branch?.name || '',
        value: Number(inv.grandTotal) - Number(inv.paidAmount),
        time: inv.purchaseDate,
        // Trả số trạng thái hóa đơn (1-8) để FE map qua INVOICE_STATUS_LABELS
        // — đồng nhất với trang Hóa đơn. status để dạng string cho khớp type chung.
        status: String(inv.status),
        invoiceStatus: inv.status,
        deliveryStatus: inv.delivery?.status,
      }));
    }

    // stock — lọc theo loại tồn (status): negative | out | low.
    const stockFilter =
      status === 'negative'
        ? Prisma.sql`AND i."onHand" < 0`
        : status === 'out'
          ? Prisma.sql`AND i."onHand" = 0`
          : status === 'low'
            ? Prisma.sql`AND i."onHand" > 0 AND i."onHand" <= i."minQuality"`
            : Prisma.sql`AND i."onHand" <= i."minQuality"`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        i.id,
        p.code AS "productCode",
        p.name AS "productName",
        b.name AS "branchName",
        i."onHand"::float8 AS "onHand",
        i."minQuality"::float8 AS "minQuality",
        p.unit
      FROM inventories i
      INNER JOIN products p ON p.id = i."productId"
      INNER JOIN branches b ON b.id = i."branchId" AND b."isActive" = true
      WHERE p."isActive" = true
        AND p."parent_name" IN (${Prisma.join(STOCK_WARNING_PARENT_NAMES)})
        ${stockFilter}
        ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.sql`AND i."branchId" IN (${Prisma.join(TASK_BRANCH_IDS)})`}
      ORDER BY i."onHand" ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      code: r.productCode,
      partner: r.productName,
      branchName: r.branchName,
      value: Number(r.onHand),
      minQuality: Number(r.minQuality),
      unit: r.unit,
      status:
        Number(r.onHand) < 0
          ? 'negative'
          : Number(r.onHand) === 0
            ? 'out'
            : 'low',
    }));
  }

  /**
   * Đếm tổng thật số bản ghi mỗi tab worklist (badge). Dùng count() — KHÔNG
   * giới hạn take như getTasks — để badge chính xác ở mọi quy mô.
   * Badge là tổng của tab (bỏ qua filter trạng thái), khớp điều kiện where
   * mặc định của từng nhánh trong getTasks.
   */
  async getTaskCounts(branchId?: number) {
    const [orders, debt, cod, stockRows] = await Promise.all([
      this.prisma.order.count({
        where: {
          orderStatus: { in: ['pending', 'confirmed', 'partially_invoiced'] },
          customer: { is: { isActive: true } },
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
      }),
      this.prisma.invoice.count({
        where: {
          debtAmount: { gt: 0 },
          status: { notIn: [2] },
          customer: { is: { isActive: true } },
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
      }),
      this.prisma.invoice.count({
        where: {
          usingCod: true,
          status: { notIn: [1, 2, 7] },
          customer: { is: { isActive: true } },
          branchId: branchId ?? { in: TASK_BRANCH_IDS },
        },
      }),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM inventories i
        INNER JOIN products p ON p.id = i."productId"
        INNER JOIN branches b ON b.id = i."branchId" AND b."isActive" = true
        WHERE p."isActive" = true
          AND p."parent_name" IN (${Prisma.join(STOCK_WARNING_PARENT_NAMES)})
          AND i."onHand" <= i."minQuality"
          ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.sql`AND i."branchId" IN (${Prisma.join(TASK_BRANCH_IDS)})`}
      `,
    ]);

    return {
      orders,
      debt,
      cod,
      stock: Number(stockRows[0]?.count || 0),
    };
  }

  /** Danh sách giá trị nhóm hàng (parent/middle/child) để đổ vào dropdown lọc. */
  async getCategoryOptions(dimension: CategoryDimension = 'parent') {
    const col =
      dimension === 'middle'
        ? Prisma.sql`p."middle_name"`
        : dimension === 'child'
          ? Prisma.sql`p."child_name"`
          : Prisma.sql`p."parent_name"`;
    const rows = await this.prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT ${col} AS value
      FROM products p
      WHERE p."isActive" = true AND COALESCE(${col}, '') <> ''
      ORDER BY value ASC
    `;
    return rows.map((r) => r.value);
  }

  async getRecentActivities(limit: number = 15) {
    const orders = await this.prisma.order.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      where: { orderStatus: { not: 'cancelled' } },
      select: {
        id: true,
        code: true,
        grandTotal: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
    });

    return orders.map((order) => ({
      id: order.id,
      code: order.code,
      customerName: order.customer?.name || 'Khách vãng lai',
      grandTotal: Number(order.grandTotal),
      createdAt: order.createdAt,
    }));
  }
}
