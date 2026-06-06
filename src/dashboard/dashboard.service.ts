import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type RangeKey = 'today' | 'week' | 'month';
export type FinRangeKey = 'd7' | 'm30' | 'all';
export type TopMetric = 'rev' | 'qty' | 'profit';
export type CategoryDimension = 'parent' | 'middle' | 'child';

interface RangeWindow {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
}

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
  private getRangeWindow(range: RangeKey): RangeWindow {
    const now = new Date();
    if (range === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 1);
      return { start, end: now, prevStart, prevEnd: start };
    }
    if (range === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start);
      prevStart.setDate(prevStart.getDate() - 7);
      return { start, end: now, prevStart, prevEnd: start };
    }
    // month
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start, end: now, prevStart, prevEnd: start };
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

  private pct(curr: number, prev: number): number {
    if (prev <= 0) return 0;
    return Number((((curr - prev) / prev) * 100).toFixed(2));
  }

  /**
   * Giá vốn (COGS) ước tính cho các đơn trong khoảng: SUM(quantity × inventory.cost),
   * khớp theo productId + branchId, chỉ chi nhánh đang hoạt động.
   * OrderItem không lưu giá vốn theo dòng nên đây là số tạm tính theo giá vốn hiện tại.
   */
  private async estimateCogs(
    start: Date,
    end: Date,
    branchId?: number,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<[{ cogs: number | null }]>`
      SELECT COALESCE(SUM(oi.quantity * inv.cost), 0)::float8 AS cogs
      FROM order_items oi
      INNER JOIN orders o ON oi."orderId" = o.id
      INNER JOIN inventories inv ON inv."productId" = oi."productId" AND inv."branchId" = o."branchId"
      INNER JOIN branches b ON b.id = o."branchId" AND b."isActive" = true
      WHERE o."orderDate" >= ${start}
        AND o."orderDate" <= ${end}
        AND o."orderStatus" != 'cancelled'
        ${branchId ? Prisma.sql`AND o."branchId" = ${branchId}` : Prisma.empty}
    `;
    return Number(rows[0]?.cogs || 0);
  }

  // ──────────────────────────── KPI Overview ────────────────────────────

  async getStatsOverview(range: RangeKey = 'month', branchId?: number) {
    try {
      const w = this.getRangeWindow(range);
      const branchFilter = branchId
        ? Prisma.sql`AND o."branchId" = ${branchId}`
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
        this.prisma.order.aggregate({
          where: this.orderWhere({ gte: w.start }, branchId),
          _sum: { grandTotal: true },
        }),
        this.prisma.order.aggregate({
          where: this.orderWhere(
            { gte: w.prevStart, lt: w.prevEnd },
            branchId,
          ),
          _sum: { grandTotal: true },
        }),
        this.prisma.order.count({
          where: this.orderWhere({ gte: w.start }, branchId),
        }),
        this.prisma.order.count({
          where: this.orderWhere(
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
        this.prisma.order.aggregate({
          where: {
            debtAmount: { gt: 0 },
            orderStatus: { not: 'cancelled' },
            // Chỉ tính công nợ của khách hàng còn hoạt động.
            customer: { is: { isActive: true } },
            ...(branchId ? { branchId } : {}),
          },
          _sum: { debtAmount: true },
          _count: true,
        }),
        this.prisma.$queryRaw<[{ amount: number | null; cnt: bigint }]>`
          SELECT COALESCE(SUM(o."grandTotal" - o."paidAmount"), 0)::float8 AS amount,
                 COUNT(*)::bigint AS cnt
          FROM orders o
          INNER JOIN order_deliveries d ON d."orderId" = o.id
          WHERE o."usingCod" = true
            AND o."orderStatus" != 'cancelled'
            AND d.status NOT IN (3, 4)
            ${branchFilter}
        `,
        this.estimateCogs(w.start, w.end, branchId),
        this.estimateCogs(w.prevStart, w.prevEnd, branchId),
      ]);

      const currentRevenueNum = Number(currentRevenue._sum.grandTotal || 0);
      const lastRevenueNum = Number(lastRevenue._sum.grandTotal || 0);
      const profit = currentRevenueNum - currCogs;
      const prevProfit = lastRevenueNum - prevCogs;
      const marginAvg =
        currentRevenueNum > 0 ? profit / currentRevenueNum : 0;
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
  ) {
    const w = this.getRangeWindow(range);
    const branchFilter = branchId
      ? Prisma.sql`AND o."branchId" = ${branchId}`
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
        ? Prisma.sql`SUM(oi.quantity)`
        : metric === 'profit'
          ? Prisma.sql`SUM(oi."totalPrice" - oi.quantity * COALESCE(inv.cost, 0))`
          : Prisma.sql`SUM(oi."totalPrice")`;

    const products = await this.prisma.$queryRaw<any[]>`
      SELECT
        oi."productId",
        oi."productCode",
        oi."productName",
        SUM(oi.quantity)::float8     AS "totalQuantity",
        SUM(oi."totalPrice")::float8 AS "totalRevenue",
        SUM(oi."totalPrice" - oi.quantity * COALESCE(inv.cost, 0))::float8 AS "totalProfit"
      FROM order_items oi
      INNER JOIN orders o ON oi."orderId" = o.id
      INNER JOIN products p ON p.id = oi."productId"
      LEFT JOIN inventories inv ON inv."productId" = oi."productId" AND inv."branchId" = o."branchId"
      WHERE o."orderDate" >= ${w.start}
        AND o."orderDate" <= ${w.end}
        AND o."orderStatus" != 'cancelled'
        ${branchFilter}
        ${catFilter}
      GROUP BY oi."productId", oi."productCode", oi."productName"
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
  async getRevenueTrend(range: RangeKey = 'today', branchId?: number) {
    const w = this.getRangeWindow(range);
    const branchFilter = branchId
      ? Prisma.sql`AND o."branchId" = ${branchId}`
      : Prisma.empty;

    const trunc =
      range === 'today' ? 'hour' : range === 'week' ? 'day' : 'week';

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        date_trunc(${trunc}, o."orderDate") AS bucket,
        SUM(o."grandTotal")::float8 AS revenue,
        COALESCE(SUM(li.cogs), 0)::float8 AS cogs
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT SUM(oi.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM order_items oi
        LEFT JOIN inventories inv
          ON inv."productId" = oi."productId" AND inv."branchId" = o."branchId"
        WHERE oi."orderId" = o.id
      ) li ON true
      WHERE o."orderDate" >= ${w.start}
        AND o."orderDate" <= ${w.end}
        AND o."orderStatus" != 'cancelled'
        ${branchFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const fmt = (d: Date): string => {
      const dt = new Date(d);
      if (range === 'today') return String(dt.getHours()).padStart(2, '0');
      if (range === 'week') {
        return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dt.getDay()];
      }
      return `Tuần ${Math.ceil(dt.getDate() / 7)}`;
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
  ) {
    const w = this.getRangeWindow(range);
    const branchFilter = branchId
      ? Prisma.sql`AND o."branchId" = ${branchId}`
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
        SUM(oi."totalPrice")::float8 AS revenue
      FROM order_items oi
      INNER JOIN orders o ON oi."orderId" = o.id
      INNER JOIN products p ON p.id = oi."productId"
      WHERE o."orderDate" >= ${w.start}
        AND o."orderDate" <= ${w.end}
        AND o."orderStatus" != 'cancelled'
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
  async getBranchComparison(range: RangeKey = 'week', metric: 'rev' | 'profit' = 'rev') {
    const w = this.getRangeWindow(range);
    const trunc =
      range === 'today' ? 'hour' : range === 'week' ? 'day' : 'week';

    const valueCol =
      metric === 'profit'
        ? Prisma.sql`SUM(o."grandTotal") - COALESCE(SUM(li.cogs), 0)`
        : Prisma.sql`SUM(o."grandTotal")`;

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        o."branchId" AS "branchId",
        b.name AS "branchName",
        date_trunc(${trunc}, o."orderDate") AS bucket,
        ${valueCol}::float8 AS value
      FROM orders o
      INNER JOIN branches b ON b.id = o."branchId" AND b."isActive" = true
      LEFT JOIN LATERAL (
        SELECT SUM(oi.quantity * COALESCE(inv.cost, 0)) AS cogs
        FROM order_items oi
        LEFT JOIN inventories inv
          ON inv."productId" = oi."productId" AND inv."branchId" = o."branchId"
        WHERE oi."orderId" = o.id
      ) li ON true
      WHERE o."orderDate" >= ${w.start}
        AND o."orderDate" <= ${w.end}
        AND o."orderStatus" != 'cancelled'
      GROUP BY o."branchId", b.name, bucket
      ORDER BY bucket ASC
    `;

    const fmt = (d: Date): string => {
      const dt = new Date(d);
      if (range === 'today') return String(dt.getHours()).padStart(2, '0');
      if (range === 'week') {
        return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dt.getDay()];
      }
      return `Tuần ${Math.ceil(dt.getDate() / 7)}`;
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

  async getFinance(finRange: FinRangeKey = 'all', branchId?: number) {
    const now = new Date();
    let since: Date | null = null;
    if (finRange === 'd7') {
      since = new Date(now);
      since.setDate(since.getDate() - 7);
    } else if (finRange === 'm30') {
      since = new Date(now);
      since.setDate(since.getDate() - 30);
    }

    const branchFilter = branchId
      ? Prisma.sql`AND o."branchId" = ${branchId}`
      : Prisma.empty;
    const sinceFilter = since
      ? Prisma.sql`AND o."orderDate" >= ${since}`
      : Prisma.empty;

    const [debtAgg, codResult, agingRows] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          debtAmount: { gt: 0 },
          orderStatus: { not: 'cancelled' },
          // Chỉ tính công nợ của khách hàng còn hoạt động.
          customer: { is: { isActive: true } },
          ...(branchId ? { branchId } : {}),
          ...(since ? { orderDate: { gte: since } } : {}),
        },
        _sum: { debtAmount: true },
        _count: true,
      }),
      this.prisma.$queryRaw<[{ amount: number | null; cnt: bigint }]>`
        SELECT COALESCE(SUM(o."grandTotal" - o."paidAmount"), 0)::float8 AS amount,
               COUNT(*)::bigint AS cnt
        FROM orders o
        INNER JOIN order_deliveries d ON d."orderId" = o.id
        WHERE o."usingCod" = true
          AND o."orderStatus" != 'cancelled'
          AND d.status NOT IN (3, 4)
          ${branchFilter}
          ${sinceFilter}
      `,
      // Aging buckets theo tuổi nợ tính từ orderDate (không có dueDate).
      this.prisma.$queryRaw<[{ in_term: number; d30: number; over30: number }]>`
        SELECT
          COALESCE(SUM(o."debtAmount") FILTER (WHERE (now()::date - o."orderDate"::date) <= 0), 0)::float8 AS in_term,
          COALESCE(SUM(o."debtAmount") FILTER (WHERE (now()::date - o."orderDate"::date) BETWEEN 1 AND 30), 0)::float8 AS d30,
          COALESCE(SUM(o."debtAmount") FILTER (WHERE (now()::date - o."orderDate"::date) > 30), 0)::float8 AS over30
        FROM orders o
        INNER JOIN customers c ON c.id = o."customerId" AND c."isActive" = true
        WHERE o."debtAmount" > 0
          AND o."orderStatus" != 'cancelled'
          ${branchFilter}
          ${sinceFilter}
      `,
    ]);

    const debt = Number(debtAgg._sum.debtAmount || 0);
    const aging = agingRows[0] || { in_term: 0, d30: 0, over30: 0 };
    const overdue = Number(aging.d30 || 0) + Number(aging.over30 || 0);

    return {
      finRange,
      debt,
      overdue,
      unpaidCount: debtAgg._count || 0,
      codAmount: Number(codResult[0]?.amount || 0),
      codCount: Number(codResult[0]?.cnt || 0),
      aging: {
        inTerm: Number(aging.in_term || 0),
        d1to30: Number(aging.d30 || 0),
        over30: Number(aging.over30 || 0),
      },
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
          orderStatus: status
            ? status
            : { notIn: ['cancelled'] },
          ...(branchId ? { branchId } : {}),
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
      const orders = await this.prisma.order.findMany({
        where: {
          debtAmount: { gt: 0 },
          orderStatus: { not: 'cancelled' },
          // Chỉ tính công nợ của khách hàng còn hoạt động.
          customer: { is: { isActive: true } },
          ...(branchId ? { branchId } : {}),
        },
        take: limit,
        orderBy: { orderDate: 'asc' },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      const now = Date.now();
      return orders.map((o) => {
        const ageDays = Math.floor(
          (now - new Date(o.orderDate).getTime()) / 86400000,
        );
        return {
          code: o.code,
          partner: o.customer?.name || 'Khách vãng lai',
          branchName: o.branch?.name || '',
          value: Number(o.debtAmount),
          ageDays,
          time: o.orderDate,
          status:
            ageDays > 30 ? 'overdue' : ageDays > 0 ? 'due' : 'in_term',
        };
      });
    }

    if (type === 'cod') {
      const orders = await this.prisma.order.findMany({
        where: {
          usingCod: true,
          orderStatus: { not: 'cancelled' },
          delivery: { status: { notIn: [3, 4] } },
          ...(branchId ? { branchId } : {}),
        },
        take: limit,
        orderBy: { orderDate: 'desc' },
        include: {
          customer: { select: { name: true } },
          branch: { select: { name: true } },
          delivery: {
            select: { status: true, statusValue: true, expectedDelivery: true },
          },
        },
      });
      return orders.map((o) => ({
        code: o.code,
        partner: o.customer?.name || 'Khách vãng lai',
        branchName: o.branch?.name || '',
        value: Number(o.grandTotal) - Number(o.paidAmount),
        time: o.delivery?.expectedDelivery || o.orderDate,
        status: o.delivery?.statusValue || 'Đang giao',
        deliveryStatus: o.delivery?.status,
      }));
    }

    // stock
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
        AND i."onHand" <= i."minQuality"
        ${branchId ? Prisma.sql`AND i."branchId" = ${branchId}` : Prisma.empty}
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
