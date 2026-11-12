import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InvoiceQueryDto } from './dto';
import { findInvoiceQuantityMismatches } from './invoice-quantity-mismatch';
import {
  findInvoicePriceWarnings,
  findInvoiceWarningIds,
} from './invoice-warnings.query';
import { InvoicesService } from './invoices.service';

const sqlOf = (mock: jest.Mock, index = 0): Prisma.Sql =>
  mock.mock.calls[index][0];

describe('InvoiceQueryDto hasWarning', () => {
  it.each([true, 'true', '1'])('accepts enabled value %s', (value) => {
    const query = plainToInstance(InvoiceQueryDto, { hasWarning: value });
    expect(query.hasWarning).toBe(true);
    expect(validateSync(query)).toEqual([]);
  });

  it.each([false, 'false', '0'])('accepts disabled value %s', (value) => {
    expect(
      plainToInstance(InvoiceQueryDto, { hasWarning: value }).hasWarning,
    ).toBe(false);
  });

  it('keeps the legacy price-only parameter independent', () => {
    const query = plainToInstance(InvoiceQueryDto, { priceWarning: 'true' });
    expect(query.priceWarning).toBe(true);
    expect(query.hasWarning).toBeUndefined();
  });
});

describe('invoice warning queries', () => {
  it('does not query an empty candidate set', async () => {
    const db = { $queryRaw: jest.fn() };
    expect(await findInvoiceWarningIds(db as any, [], true)).toEqual([]);
    expect(await findInvoicePriceWarnings(db as any, [])).toEqual([]);
    expect(await findInvoiceQuantityMismatches(db as any, [])).toEqual(
      new Map(),
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('shares the exact price condition between the icon and filter', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await findInvoicePriceWarnings(db as any, [10, 20]);
    await findInvoiceWarningIds(db as any, [10, 20], false);
    const details = sqlOf(db.$queryRaw);
    const filter = sqlOf(db.$queryRaw, 1);
    const source = (query: Prisma.Sql) =>
      query.sql.slice(query.sql.indexOf('FROM invoices i'));

    expect(source(details)).toBe(source(filter));
    expect(filter.sql).toContain('i.status <> 2');
    expect(filter.sql).toContain('i."priceBookId" IN (2, 3)');
    expect(filter.sql).toContain('pbd."isActive" = true');
    expect(filter.sql).toContain('(d.price - d.discount) < pbd.price');
    expect(filter.sql).not.toContain('UNION');
    expect(filter.values).toEqual([10, 20]);
  });

  it('unions both warning types using the quantity condition of the icon', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await findInvoiceWarningIds(db as any, [10, 20], true);
    await findInvoiceQuantityMismatches(db as any, [10, 20]);
    const filter = sqlOf(db.$queryRaw);
    const details = sqlOf(db.$queryRaw, 1);
    const ctes = (query: Prisma.Sql) =>
      query.sql.slice(
        query.sql.indexOf('inv AS'),
        query.sql.indexOf('\n    SELECT'),
      );

    expect(filter.sql).toMatch(/UNION\s+SELECT a.id FROM agg a/);
    expect(filter.sql).toContain('a.iq <> GREATEST(a.oq - a.pq, 0)');
    expect(details.sql).toContain('a.iq <> GREATEST(a.oq - a.pq, 0)');
    expect(ctes(filter).trim()).toBe(ctes(details).trim());
    expect(filter.values).toEqual([10, 20, 10, 20]);
  });

  it('keeps previous split invoices outside the candidate IDs and date range', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await findInvoiceWarningIds(db as any, [20], true);
    const query = sqlOf(db.$queryRaw);
    const previous = query.sql.slice(
      query.sql.indexOf('prev_inv AS'),
      query.sql.indexOf('lines AS'),
    );
    expect(previous).toContain('p."orderId" = inv."orderId" AND p.status <> 2');
    expect(previous).toContain(
      '(p."createdAt", p.id) < (inv."createdAt", inv.id)',
    );
    expect(previous).not.toMatch(/p\.id IN|purchaseDate|branchId/);
    expect(query.sql).toContain("sum(q) FILTER (WHERE src = 'i')");
    expect(query.sql).toContain('GROUP BY id, pid');
  });

  it.each([
    { ordered: 6, previous: 0, invoiced: 8, expected: 6, previousCodes: [] },
    {
      ordered: 10,
      previous: 6,
      invoiced: 5,
      expected: 4,
      previousCodes: ['HD-PREVIOUS'],
    },
  ])(
    'preserves quantity details for $ordered ordered and $invoiced invoiced',
    async (row) => {
      const db = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 20,
            orderCode: 'DH128332',
            previousCodes: row.previousCodes,
            productCode: 'SRTDL',
            productName: 'Siro Te Dua Luoi',
            unit: 'chai',
            orderQuantity: row.ordered,
            previousQuantity: row.previous,
            invoiceQuantity: row.invoiced,
          },
        ]),
      };
      const warnings = await findInvoiceQuantityMismatches(db as any, [20]);
      expect(warnings.get(20)).toEqual({
        orderCode: 'DH128332',
        previousInvoiceCodes: row.previousCodes,
        items: [
          expect.objectContaining({
            productCode: 'SRTDL',
            orderQuantity: row.ordered,
            previousQuantity: row.previous,
            expectedQuantity: row.expected,
            invoiceQuantity: row.invoiced,
          }),
        ],
      });
    },
  );
});

describe('InvoicesService warning filter', () => {
  function setup(warningIds = [2, 3, 4]) {
    const invoices = warningIds.map((id) => ({ id }));
    const prisma = {
      invoice: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([1, 2, 3, 4].map((id) => ({ id })))
          .mockResolvedValue(invoices),
        count: jest.fn().mockResolvedValue(invoices.length),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { grandTotal: 100, paidAmount: 20 },
          _count: { _all: invoices.length },
        }),
      },
      returnOrder: { groupBy: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue(invoices),
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ count: BigInt(invoices.length) }])
        .mockResolvedValue(invoices),
    };
    const service = new InvoicesService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service as any, 'getInvoiceReturnSummaries')
      .mockResolvedValue(new Map());
    jest
      .spyOn(service as any, 'attachPriceBookWarnings')
      .mockImplementation(async (rows: any[]) => rows);
    return { prisma, service };
  }

  const filters = {
    hasWarning: true,
    branchIds: [1, 2, 3],
    statusIds: [1, 3, 5, 6, 7],
    soldByIds: [7, 8, 9],
    fromPurchaseDate: '2026-11-10T17:00:00.000Z',
    toPurchaseDate: '2026-11-11T16:59:59.999Z',
  };

  it('does not query candidates when both warning filters are off', async () => {
    const { prisma, service } = setup();
    const where = await (service as any).buildInvoiceListWhere({});
    expect(where.id).toBeUndefined();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('applies warnings before pagination while preserving the other filters', async () => {
    const { prisma, service } = setup();
    await service.findAll({ ...filters, page: 2, limit: 1 });
    const candidateQuery = prisma.invoice.findMany.mock.calls[0][0];
    // Lần 2: quy nhóm cảnh báo (OR) về danh sách id; lần 3: trang danh sách
    const listQuery = prisma.invoice.findMany.mock.calls[2][0];
    expect(candidateQuery.select).toEqual({ id: true });
    expect(candidateQuery.skip).toBeUndefined();
    expect(candidateQuery.take).toBeUndefined();
    expect(listQuery).toMatchObject({
      where: {
        id: { in: [2, 3, 4] },
        branchId: { in: filters.branchIds },
        status: { in: filters.statusIds },
        soldById: { in: filters.soldByIds },
        purchaseDate: {
          gte: new Date(filters.fromPurchaseDate),
          lte: new Date(filters.toPurchaseDate),
        },
      },
      skip: 1,
      take: 1,
    });
    expect(prisma.invoice.count).toHaveBeenCalledWith({
      where: listQuery.where,
    });
  });

  it('uses the same warning IDs for totals and Excel filtering', async () => {
    const { prisma, service } = setup();
    const totals = await service.getTotals(filters);
    const exportWhere = await (service as any).buildInvoiceExportWhere(filters);
    const totalsWhere = prisma.invoice.aggregate.mock.calls[0][0].where;
    expect(exportWhere).toEqual(totalsWhere);
    expect(exportWhere.id).toEqual({ in: [2, 3, 4] });
    expect(totals.count).toBe(3);
    expect(totals.customerDebt).toBe(100);
    expect(prisma.returnOrder.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoice: totalsWhere }),
      }),
    );
  });

  it('uses the union when both new and legacy parameters are enabled', async () => {
    const { prisma, service } = setup();
    await (service as any).buildInvoiceListWhere({
      hasWarning: true,
      priceWarning: true,
    });
    expect(sqlOf(prisma.$queryRaw).sql).toContain('UNION');
  });

  it('quantityWarning: chỉ lệch SL (không gộp với điều kiện giá)', async () => {
    const { prisma, service } = setup([3]);
    const where = await (service as any).buildInvoiceListWhere({
      quantityWarning: true,
    });
    const q = sqlOf(prisma.$queryRaw);
    expect(q.sql).toContain('a.iq <> GREATEST(a.oq - a.pq, 0)');
    expect(q.sql).not.toMatch(/UNION\s+SELECT a\.id/);
    expect(q.sql).not.toContain('pbd.price');
    expect(where.id).toEqual({ in: [3] });
  });

  it('priceWarning + quantityWarning: hóa đơn có ít nhất 1 trong 2 (OR)', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: 2 }, { id: 4 }]);
    await (service as any).buildInvoiceListWhere({
      priceWarning: true,
      quantityWarning: true,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(prisma.$queryRaw).sql).toMatch(/UNION\s+SELECT a\.id FROM agg a/);
    expect(prisma.invoice.findMany.mock.calls[1][0].where.AND).toEqual([
      { OR: [{ id: { in: [2, 4] } }] },
    ]);
  });

  it('nhiều ô cảnh báo khác loại: OR; "hủy còn giao hàng" bỏ qua bộ lọc trạng thái', async () => {
    const { prisma, service } = setup();
    jest.spyOn(service as any, 'findOrphanedPackingInvoiceIds').mockResolvedValue([9]);
    const where = await (service as any).buildInvoiceListWhere({
      statusIds: [1, 3],
      hasShippingFee: true,
      hasColdItems: true,
      orphanedPacking: true,
    });
    const idsQuery = prisma.invoice.findMany.mock.calls[0][0];
    expect(idsQuery.where.status).toBeUndefined();
    expect(idsQuery.where.AND).toEqual([
      {
        OR: [
          {
            AND: [
              { status: { in: [1, 3] } },
              {
                OR: [
                  { shippingFee: { gt: 0 } },
                  { details: { some: { product: { cargoType: 'COLD' } } } },
                ],
              },
            ],
          },
          { status: 2, id: { in: [9] } },
        ],
      },
    ]);
    expect(where.status).toBeUndefined();
    expect(where.id).toEqual({ in: [1, 2, 3, 4] });
  });

  it('preserves legacy price-only behavior', async () => {
    const { prisma, service } = setup([2]);
    const where = await (service as any).buildInvoiceListWhere({
      priceWarning: true,
    });
    expect(where.id).toEqual({ in: [2] });
    expect(sqlOf(prisma.$queryRaw).sql).not.toContain('UNION');
  });

  it('returns no results when there are no warnings', async () => {
    const { service } = setup([]);
    const where = await (service as any).buildInvoiceListWhere(filters);
    expect(where.id).toEqual({ in: [-1] });
  });

  it('does not query warning SQL when the other filters match no invoices', async () => {
    const { prisma, service } = setup();
    prisma.invoice.findMany.mockReset().mockResolvedValue([]);
    const where = await (service as any).buildInvoiceListWhere(filters);
    expect(where.id).toEqual({ in: [-1] });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('intersects existing IDs and checks candidates in bounded batches', async () => {
    const { prisma, service } = setup();
    prisma.invoice.findMany
      .mockReset()
      .mockResolvedValue(
        Array.from({ length: 2001 }, (_, index) => ({ id: index + 1 })),
      );
    prisma.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 2001 }]);
    const where = { id: { in: [2, 2001, 3000] } };
    await (service as any).applyInvoiceAlertFilters(where, filters);
    // Id lệch giá/SL đi vào nhánh OR; truy vấn cuối vẫn giữ id của các bộ lọc khác
    const final = prisma.invoice.findMany.mock.calls[1][0].where;
    expect(final.AND).toEqual([{ OR: [{ id: { in: [2, 2001] } }] }]);
    expect(final.id).toEqual({ in: [2, 2001, 3000] });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(prisma.$queryRaw).values).toHaveLength(4000);
    expect(sqlOf(prisma.$queryRaw, 1).values).toEqual([2001, 2001]);
  });

  it.each([
    'remainingAmount',
    'returnOrderAmount',
    'cashRefundAmount',
    'debtOffsetAmount',
  ])(
    'keeps warning IDs in raw count and sorted ID SQL for %s',
    async (orderBy) => {
      const { prisma, service } = setup();
      await service.findAll({ ...filters, orderBy, page: 2, limit: 1 });
      for (const [sql, ids] of prisma.$queryRawUnsafe.mock.calls) {
        expect(sql).toContain('i.id = ANY($1)');
        expect(ids).toEqual([2, 3, 4]);
      }
      expect(prisma.$queryRawUnsafe.mock.calls[1].slice(-2)).toEqual([1, 1]);
    },
  );
});
