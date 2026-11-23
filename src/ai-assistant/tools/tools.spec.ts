import type { AiScope } from '../ai-scope';
import { clip, type AiTool, type AiToolContext } from './common';
import type { AiToolDeps } from './deps';
import { AI_TOOLS } from './index';
import { customerDebtsTool } from './customer-debts.tool';
import { customerLookupTool } from './customer-lookup.tool';
import { invoicesSummaryTool } from './invoices-summary.tool';
import { leadsSummaryTool } from './leads-summary.tool';
import { ordersSummaryTool } from './orders-summary.tool';
import { quotesSummaryTool } from './quotes-summary.tool';
import { revenueSummaryTool } from './revenue-summary.tool';
import { stockLevelsTool } from './stock-levels.tool';

const NOW = new Date('2026-11-22T03:00:00Z');

const makeScope = (
  permissions: string[],
  options: { canViewOtherStaffData?: boolean; branchId?: number | null } = {},
): AiScope => {
  const can = (permission: string) => permissions.includes(permission);
  return {
    userId: 9,
    userName: 'Sale B',
    can,
    user: {
      id: 9,
      name: 'Sale B',
      canViewOtherStaffData: options.canViewOtherStaffData ?? false,
      branchId: 1,
      branchIds: [1],
      roles: ['Sale'],
    },
    branchId: options.branchId === undefined ? 5 : options.branchId,
    leadActor: { id: 9, name: 'Sale B', ownOnly: !can('leads:update') },
    quoteActor: { id: 9, name: 'Sale B', ownOnly: !can('quotes:view_all') },
  };
};

const makeDeps = () => {
  const deps = {
    prisma: {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 3, name: 'Sale PIC' }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 11 }]),
    },
    invoices: {
      getTotals: jest.fn().mockResolvedValue({
        count: 2,
        totalAmount: 1000,
        shippingFee: 0,
        grandTotal: 1000,
        paidAmount: 400,
        debtAmount: 600,
        returnOrderAmount: 0,
        remainingAmount: 600,
      }),
      findAll: jest.fn().mockResolvedValue({
        data: [
          {
            id: 1,
            code: 'HD000001',
            purchaseDate: new Date('2026-11-20T03:00:00Z'),
            customer: {
              id: 4,
              code: 'KH000004',
              name: 'Quán A',
              contactNumber: '0900000000',
              addresses: [{ address: '1 Đường B' }],
            },
            branch: { id: 1, name: 'Kho Sài Gòn' },
            soldBy: { id: 9, name: 'Sale B' },
            order: null,
            grandTotal: 1000,
            paidAmount: 400,
            remainingAmount: 600,
            status: 3,
          },
        ],
        total: 2,
        statusCounts: { all: 2, '3': 2 },
      }),
    },
    orders: {
      getTotals: jest.fn().mockResolvedValue({
        count: 0,
        totalAmount: 0,
        shippingFee: 0,
        grandTotal: 0,
        paidAmount: 0,
        debtAmount: 0,
      }),
      findAll: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, statusCounts: { all: 0 } }),
    },
    customers: {
      findAll: jest.fn().mockResolvedValue({
        data: [
          {
            id: 4,
            code: 'KH000004',
            name: 'Quán A',
            contactNumber: '0900000000',
            phone: '0900000000',
            email: 'a@example.com',
            addresses: [{ address: '1 Đường B' }],
            customerType: { name: 'Quán' },
            customerGroupDetails: [{ customerGroup: { name: 'VIP' } }],
            branch: { name: 'Kho Sài Gòn' },
            totalPurchased: 5000,
            totalRevenue: 4500,
            totalDebt: 700,
            isActive: true,
            createdAt: new Date('2026-01-02T03:00:00Z'),
          },
        ],
        total: 1,
      }),
      getSalePic: jest.fn().mockResolvedValue({ salePicId: 3 }),
    },
    debtTracking: {
      getSummary: jest.fn().mockResolvedValue({
        totalCustomers: 0,
        totalDebt: 0,
        overdueAmount: 0,
        dueAmount: 0,
        dueSoonAmount: 0,
        notDueAmount: 0,
        requiredPaymentAmount: 0,
        overLimitAmount: 0,
        customersOverLimit: 0,
        customersWithOpenTicket: 0,
        byDebtStatus: { OVERDUE: 0, DUE: 0, NORMAL: 0 },
      }),
      findAll: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
      }),
      getDetail: jest.fn(),
    },
    inventories: {
      getInventoryByBranch: jest.fn().mockResolvedValue([
        {
          productId: 11,
          productCode: 'SP01',
          productName: 'Trân châu',
          branchName: 'Văn phòng Hà Nội',
          cost: 12000,
          onHand: 3,
          reserved: 1,
          onOrder: 0,
          minQuality: 5,
          damagedQuantity: 0,
          nearExpiryQuantity: 0,
          promoQuantity: 0,
          product: {
            code: 'SP01',
            name: 'Trân châu',
            basePrice: 20000,
            unit: 'gói',
            isActive: true,
          },
          branch: { id: 5, name: 'Văn phòng Hà Nội' },
        },
      ]),
      getLowStockProducts: jest.fn().mockResolvedValue([]),
    },
    leads: {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: 12,
            name: 'Chị Thư',
            phone: '0913597795',
            zaloPhone: '0913597795',
            phoneNormalized: '0913597795',
            category: 'cafe',
            status: 'caring',
            source: 'facebook',
            channelName: 'LerMao',
            salePic: { id: 9, name: 'Sale B' },
            cskhUser: { id: 1, name: 'CSKH A' },
            customers: [],
            createdAt: new Date('2026-11-01T03:00:00Z'),
            convertedAt: null,
          },
        ],
        total: 1,
      }),
      channelFilterOptions: jest.fn().mockResolvedValue([]),
    },
    quotes: {
      list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    },
    dashboard: {
      getStatsOverview: jest.fn().mockResolvedValue({
        currentRevenue: 1000,
        lastRevenue: 800,
        revenueChange: 25,
        invoiceCount: 2,
        invoiceChange: 0,
        aov: 500,
        aovChange: 0,
        profit: 300,
        profitChange: 10,
        marginAvg: 0.3,
        unpaidInvoices: 1,
        unpaidAmount: 600,
        codAmount: 0,
        codCount: 0,
      }),
      getRevenueTrend: jest
        .fn()
        .mockResolvedValue([{ label: '20/11', revenue: 1000, profit: 300 }]),
      getBranchComparison: jest.fn().mockResolvedValue({
        labels: [],
        branches: [{ id: 1, name: 'Kho Sài Gòn', data: [], total: 1000 }],
      }),
    },
  };
  return deps;
};

type Rows = Record<string, unknown>[];
interface Result {
  [key: string]: unknown;
  error?: string;
  invoices?: Rows;
  customers?: Rows;
  items?: Rows;
  leads?: Rows;
  trend?: Rows;
}

/** Tham số thứ `index` của lượt gọi thứ `call`. */
const argOf = (fn: jest.Mock, index = 0, call = 0) =>
  (fn.mock.calls as unknown[][])[call][index];

const run = (
  tool: AiTool,
  scope: AiScope,
  deps: ReturnType<typeof makeDeps>,
  args: Record<string, unknown> = {},
) => {
  const context: AiToolContext = {
    scope,
    now: NOW,
    deps: deps as unknown as AiToolDeps,
  };
  return tool.run(context, args) as Promise<Result>;
};

const text = (value: unknown) => JSON.stringify(value);

describe('AI tools', () => {
  it('có đủ 9 công cụ, tên không trùng', () => {
    const names = AI_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(9);
  });

  it.each([
    [invoicesSummaryTool, ['invoices:view']],
    [ordersSummaryTool, ['orders:view']],
    [customerLookupTool, ['customers:view']],
    [customerDebtsTool, ['debt_tracking:view']],
    [stockLevelsTool, ['inventory:view']],
    [stockLevelsTool, ['products:view']],
    [leadsSummaryTool, ['leads:view']],
    [quotesSummaryTool, ['quotes:view']],
    [revenueSummaryTool, ['dashboard:view']],
  ])('available() theo quyền #%#', (tool: AiTool, permissions: string[]) => {
    expect(tool.available(makeScope(permissions))).toBe(true);
    expect(tool.available(makeScope([]))).toBe(false);
  });

  it('công cụ không mở bằng quyền không liên quan', () => {
    const scope = makeScope(['customers:view_debt', 'reports:sale_branch']);
    expect(customerDebtsTool.available(scope)).toBe(false);
    expect(revenueSummaryTool.available(scope)).toBe(false);
    expect(AI_TOOLS.filter((tool) => tool.available(scope))).toEqual([]);
  });

  it('invoices_summary truyền scope.user làm currentUser và bỏ SĐT / địa chỉ', async () => {
    const deps = makeDeps();
    const scope = makeScope(['invoices:view']);
    const result = await run(invoicesSummaryTool, scope, deps, {
      from: '2026-11-01',
      to: '2026-11-22',
    });
    expect(deps.invoices.getTotals).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPurchaseDate: '2026-11-01T00:00:00.000+07:00',
        toPurchaseDate: '2026-11-22T23:59:59.999+07:00',
        statusIds: [1, 3, 4, 5, 6, 7],
      }),
      scope.user,
    );
    expect(argOf(deps.invoices.findAll, 1)).toBe(scope.user);
    expect(result.invoices![0]).toEqual(
      expect.objectContaining({
        code: 'HD000001',
        date: '2026-11-20',
        customer: { code: 'KH000004', name: 'Quán A' },
        status: 'Đang xử lý',
      }),
    );
    expect(result.countsByStatus).toEqual({ 'Đang xử lý': 2 });
    expect(result.moreRows).toBe(true);
    expect(text(result)).not.toMatch(/0900000000|Đường B/);
  });

  it('invoices_summary báo lỗi ngày sai định dạng', async () => {
    const deps = makeDeps();
    const result = await run(
      invoicesSummaryTool,
      makeScope(['invoices:view']),
      deps,
      { from: '22/11/2026' },
    );
    expect(result.error).toMatch(/invalid_date/);
    expect(deps.invoices.findAll).not.toHaveBeenCalled();
  });

  it('orders_summary truyền scope.user và mặc định bỏ đơn đã hủy', async () => {
    const deps = makeDeps();
    const scope = makeScope(['orders:view']);
    await run(ordersSummaryTool, scope, deps, { currentBranchOnly: true });
    const query = argOf(deps.orders.findAll) as Record<string, unknown>;
    expect(argOf(deps.orders.findAll, 1)).toBe(scope.user);
    expect(query.statuses).not.toContain('cancelled');
    expect(query.branchId).toBe(5);
  });

  it('customer_debts thêm salePicIds=[user.id] khi không xem dữ liệu người khác', async () => {
    const deps = makeDeps();
    await run(customerDebtsTool, makeScope(['debt_tracking:view']), deps, {
      search: 'Quán A',
    });
    expect(deps.debtTracking.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ salePicIds: [9], search: 'Quán A' }),
    );
    expect(deps.debtTracking.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ salePicIds: [9] }),
    );
  });

  it('customer_debts không giới hạn Sale PIC khi được xem dữ liệu người khác', async () => {
    const deps = makeDeps();
    await run(
      customerDebtsTool,
      makeScope(['debt_tracking:view'], { canViewOtherStaffData: true }),
      deps,
    );
    expect(argOf(deps.debtTracking.findAll)).not.toHaveProperty('salePicIds');
  });

  it('customer_lookup chỉ có công nợ khi có customers:view_debt, không SĐT / email / địa chỉ', async () => {
    const deps = makeDeps();
    const without = await run(
      customerLookupTool,
      makeScope(['customers:view']),
      deps,
      { query: 'KH000004' },
    );
    expect(without.customers![0]).toEqual(
      expect.objectContaining({
        code: 'KH000004',
        groups: ['VIP'],
        salePic: 'Sale PIC',
      }),
    );
    expect(without.customers![0]).not.toHaveProperty('currentDebt');
    expect(text(without)).not.toMatch(/0900000000|example\.com|Đường B/);

    const withDebt = await run(
      customerLookupTool,
      makeScope(['customers:view', 'customers:view_debt']),
      makeDeps(),
      { query: 'KH000004' },
    );
    expect(withDebt.customers![0].currentDebt).toBe(700);
  });

  it('stock_levels không có giá vốn khi thiếu products:view_cost_price', async () => {
    const deps = makeDeps();
    const result = await run(
      stockLevelsTool,
      makeScope(['inventory:view']),
      deps,
      { product: 'trân châu' },
    );
    expect(deps.inventories.getInventoryByBranch).toHaveBeenCalledWith(5, [11]);
    expect(result.items![0]).toEqual(
      expect.objectContaining({ code: 'SP01', onHand: 3, basePrice: 20000 }),
    );
    expect(result.items![0]).not.toHaveProperty('cost');
    expect(text(result)).not.toContain('12000');

    const withCost = await run(
      stockLevelsTool,
      makeScope(['inventory:view', 'products:view_cost_price']),
      makeDeps(),
      { product: 'trân châu' },
    );
    expect(withCost.items![0].cost).toBe(12000);
  });

  it('stock_levels không tìm thấy sản phẩm thì không tra cả chi nhánh', async () => {
    const deps = makeDeps();
    deps.prisma.$queryRaw.mockResolvedValue([]);
    const result = await run(
      stockLevelsTool,
      makeScope(['inventory:view']),
      deps,
      { product: 'không có' },
    );
    expect(deps.inventories.getInventoryByBranch).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });

  it('revenue_summary không có lợi nhuận khi thiếu reports:sale_profit', async () => {
    const deps = makeDeps();
    const result = await run(
      revenueSummaryTool,
      makeScope(['dashboard:view']),
      deps,
      { breakdown: 'trend' },
    );
    expect(result.revenue).toBe(1000);
    expect(text(result)).not.toMatch(/rofit|margin/i);
    expect(deps.dashboard.getStatsOverview).toHaveBeenCalledWith(
      'custom',
      undefined,
      {
        from: new Date('2026-11-01T00:00:00.000+07:00'),
        to: new Date('2026-11-22T23:59:59.999+07:00'),
      },
    );

    const branch = await run(
      revenueSummaryTool,
      makeScope(['dashboard:view']),
      makeDeps(),
      { breakdown: 'branch' },
    );
    expect(text(branch)).not.toMatch(/rofit/i);

    const withProfit = await run(
      revenueSummaryTool,
      makeScope(['dashboard:view', 'reports:sale_profit']),
      makeDeps(),
      { breakdown: 'trend' },
    );
    expect(withProfit.grossProfit).toBe(300);
    expect(withProfit.trend![0].grossProfit).toBe(300);
  });

  it('leads_summary truyền leadActor (ownOnly) và không trả SĐT', async () => {
    const deps = makeDeps();
    const scope = makeScope(['leads:view']);
    const result = await run(leadsSummaryTool, scope, deps);
    expect(scope.leadActor.ownOnly).toBe(true);
    for (const call of deps.leads.list.mock.calls as unknown[][])
      expect(call[1]).toBe(scope.leadActor);
    expect(result.leads![0]).toEqual(
      expect.objectContaining({
        code: 'LEAD000012',
        status: 'Đang chăm sóc',
        source: 'Fanpage',
        salePic: 'Sale B',
      }),
    );
    expect(text(result)).not.toContain('0913597795');
  });

  it('quotes_summary truyền quoteActor', async () => {
    const deps = makeDeps();
    const scope = makeScope(['quotes:view']);
    await run(quotesSummaryTool, scope, deps, { statuses: ['sent'] });
    expect(deps.quotes.list).toHaveBeenCalledWith(
      expect.objectContaining({ tab: 'quotes', status: ['sent'] }),
      scope.quoteActor,
    );
  });
});

describe('clip', () => {
  it('không cắt đôi emoji (để lại nửa cặp surrogate)', () => {
    const out = clip('ab😀cd', 4)!;
    expect(out).toBe('ab…');
    expect(JSON.stringify(out)).not.toMatch(/\\ud83d/i);
    expect(clip('ab😀cd', 5)).toBe('ab😀…');
  });
});
