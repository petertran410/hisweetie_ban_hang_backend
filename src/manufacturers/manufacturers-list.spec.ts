import { BadRequestException } from '@nestjs/common';
import { ManufacturersController } from './manufacturers.controller';
import { ManufacturersService } from './manufacturers.service';
import { PrismaService } from '../prisma/prisma.service';
import { PayablesService } from './payables.service';

interface BatchWhere {
  isExternal?: boolean;
  status?: number;
  debtAmount?: { gt: number };
}

interface ManufacturerWhere {
  isActive?: boolean;
  OR?: Array<{ name?: { contains: string }; code?: { contains: string } }>;
  AND?: ManufacturerWhere[];
  productions?: { some?: BatchWhere; none?: BatchWhere };
}

interface ListArgs {
  where: ManufacturerWhere;
  skip: number;
  take: number;
}

function controllerFixture() {
  const list = jest
    .fn<
      ReturnType<ManufacturersService['list']>,
      Parameters<ManufacturersService['list']>
    >()
    .mockResolvedValue({ data: [], total: 0, pageSize: 30 });
  return {
    list,
    controller: new ManufacturersController(
      { list } as unknown as ManufacturersService,
      {} as PayablesService,
    ),
  };
}

describe('manufacturer activity filtering', () => {
  const manufacturer = {
    findMany: jest
      .fn<Promise<ManufacturerFixture[]>, [ListArgs]>()
      .mockResolvedValue([]),
    count: jest
      .fn<Promise<number>, [{ where: ManufacturerWhere }]>()
      .mockResolvedValue(0),
  };
  const service = new ManufacturersService({
    manufacturer,
  } as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it.each([
    { includeInactive: false, isActive: undefined, expected: true },
    { includeInactive: true, isActive: undefined, expected: undefined },
    { includeInactive: false, isActive: false, expected: false },
    { includeInactive: true, isActive: true, expected: true },
  ])(
    'filters before pagination and counts with the same predicate: %j',
    async ({ includeInactive, isActive, expected }) => {
      await service.list(' Trà ', includeInactive, 15, 30, isActive);
      const list = manufacturer.findMany.mock.calls[0][0];
      const count = manufacturer.count.mock.calls[0][0];
      expect(list.where.isActive).toBe(expected);
      expect(list.where.OR).toEqual([
        { name: { contains: 'Trà', mode: 'insensitive' } },
        { code: { contains: 'Trà', mode: 'insensitive' } },
      ]);
      expect(list).toMatchObject({ take: 15, skip: 30 });
      expect(count.where).toEqual(list.where);
    },
  );

  it.each([
    [{ isActive: 'false' }, false, false],
    [{ isActive: 'true' }, false, true],
    [{ includeInactive: 'true' }, true, undefined],
    [{}, false, undefined],
  ])(
    'passes activity and legacy picker filters to the service: %j',
    async (query, includeInactive, isActive) => {
      const { list, controller } = controllerFixture();
      await controller.list(query, { user: { id: 7 } });
      expect(list).toHaveBeenCalledWith(
        undefined,
        includeInactive,
        undefined,
        undefined,
        isActive,
        { hasInProgress: undefined, hasDebt: undefined },
      );
    },
  );

  it('rejects an invalid status before querying manufacturers', () => {
    const { list, controller } = controllerFixture();
    expect(() =>
      controller.list({ isActive: 'inactive' }, { user: { id: 7 } }),
    ).toThrow(BadRequestException);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ['true', 'true', true, true],
    ['true', 'false', true, false],
    ['false', 'true', false, true],
    ['false', 'false', false, false],
    [undefined, undefined, undefined, undefined],
  ])(
    'parses the optional production filters (%s/%s)',
    async (hasInProgress, hasDebt, expectedProgress, expectedDebt) => {
      const { list, controller } = controllerFixture();
      await controller.list(
        {
          search: 'Trà',
          pageSize: '15',
          currentItem: '30',
          hasInProgress,
          hasDebt,
        },
        { user: { id: 7 } },
      );
      expect(list).toHaveBeenCalledWith('Trà', false, '15', '30', undefined, {
        hasInProgress: expectedProgress,
        hasDebt: expectedDebt,
      });
    },
  );

  it.each(['hasInProgress', 'hasDebt'])(
    'rejects every non-boolean wire value for %s',
    (key) => {
      const { list, controller } = controllerFixture();
      for (const value of [
        '',
        'TRUE',
        '1',
        'yes',
        false,
        null,
        ['true', 'false'],
        {},
      ]) {
        expect(() =>
          controller.list({ [key]: value }, { user: { id: 7 } }),
        ).toThrow(BadRequestException);
      }
      expect(list).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'keeps production predicates independent and applies them before pagination (%s)',
    async (value) => {
      await service.list('Trà', true, 15, 30, false, {
        hasInProgress: value,
        hasDebt: value,
      });
      const list = manufacturer.findMany.mock.calls[0][0];
      const relation = value ? 'some' : 'none';
      expect(list).toMatchObject({
        where: {
          isActive: false,
          AND: [
            { productions: { [relation]: { isExternal: true, status: 4 } } },
            {
              productions: {
                [relation]: {
                  isExternal: true,
                  status: 2,
                  debtAmount: { gt: 0.005 },
                },
              },
            },
          ],
        },
        skip: 30,
        take: 15,
      });
      expect(manufacturer.count.mock.calls[0][0].where).toEqual(list.where);
    },
  );
});

interface BatchFixture {
  manufacturerId: number;
  isExternal: boolean;
  status: number;
  debtAmount: number;
  materialValue?: number;
  supplierId?: number | null;
  feeCurrency?: 'VND' | 'CNY';
  totalPayable?: number;
  paidAmount?: number;
  foreignDebt?: number;
}

const batch = (
  manufacturerId: number,
  status: number,
  debtAmount: number,
  extra: Partial<BatchFixture> = {},
): BatchFixture => ({
  manufacturerId,
  isExternal: true,
  status,
  debtAmount,
  ...extra,
});

interface ManufacturerFixture {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  supplierId: number | null;
  batches: BatchFixture[];
  availableCredit?: number;
  purchaseDebt?: number;
}

const fixtures: ManufacturerFixture[] = [
  {
    id: 1,
    code: 'NSX001',
    name: 'A - Chưa có phiếu',
    isActive: true,
    supplierId: 9,
    batches: [],
  },
  {
    id: 2,
    code: 'NSX002',
    name: 'B - Đang gia công giá trị 0',
    isActive: true,
    supplierId: 9,
    batches: [batch(2, 4, 0, { materialValue: 0 })],
  },
  {
    id: 3,
    code: 'NSX003',
    name: 'C - Còn nợ đã đổi NCC',
    isActive: true,
    supplierId: 99,
    batches: [
      batch(3, 2, 50, {
        totalPayable: 100,
        paidAmount: 50,
        supplierId: 9,
        feeCurrency: 'VND',
      }),
    ],
  },
  {
    id: 4,
    code: 'NSX004',
    name: 'D - Có hai phiếu riêng CNY',
    isActive: true,
    supplierId: 9,
    batches: [batch(4, 4, 0), batch(4, 2, 350000, { feeCurrency: 'CNY' })],
  },
  {
    id: 5,
    code: 'NSX005',
    name: 'E - Đã thanh toán hết',
    isActive: true,
    supplierId: null,
    batches: [batch(5, 2, 0, { totalPayable: 100, paidAmount: 100 })],
  },
  {
    id: 6,
    code: 'NSX006',
    name: 'F - Phiếu tạm hoặc hủy',
    isActive: true,
    supplierId: 9,
    batches: [batch(6, 1, 100), batch(6, 3, 100)],
  },
  {
    id: 7,
    code: 'NSX007',
    name: 'G - Ngừng hoạt động',
    isActive: false,
    supplierId: null,
    batches: [batch(7, 4, 0), batch(7, 2, 80)],
  },
  {
    id: 8,
    code: 'NSX008',
    name: 'H - Ứng trước chưa cấn',
    isActive: true,
    supplierId: 9,
    availableCredit: 500,
    batches: [batch(8, 2, 100)],
  },
  {
    id: 9,
    code: 'NSX009',
    name: 'I - Chỉ nợ mua hàng NCC',
    isActive: true,
    supplierId: 9,
    purchaseDebt: 1000,
    batches: [],
  },
  {
    id: 10,
    code: 'NSX010',
    name: 'J - Trong ngưỡng',
    isActive: true,
    supplierId: null,
    batches: [batch(10, 2, 0.005)],
  },
  {
    id: 11,
    code: 'NSX011',
    name: 'K - Vượt ngưỡng',
    isActive: true,
    supplierId: null,
    batches: [batch(11, 2, 0.01)],
  },
  {
    id: 12,
    code: 'NSX012',
    name: 'L - CNY đã tất toán VND',
    isActive: true,
    supplierId: 9,
    batches: [batch(12, 2, 0, { feeCurrency: 'CNY', foreignDebt: 1 })],
  },
  {
    id: 13,
    code: 'NSX013',
    name: 'M - Sản xuất nội bộ không tính',
    isActive: true,
    supplierId: null,
    batches: [
      batch(13, 4, 0, { isExternal: false }),
      batch(13, 2, 100, { isExternal: false }),
    ],
  },
];

// Evaluate only the Prisma predicates generated by this read-only list query.
function matches(row: ManufacturerFixture, where: ManufacturerWhere): boolean {
  if (where.isActive !== undefined && row.isActive !== where.isActive)
    return false;
  if (
    where.OR &&
    !where.OR.some(
      (term) =>
        (term.name &&
          row.name
            .toLocaleLowerCase()
            .includes(term.name.contains.toLocaleLowerCase())) ||
        (term.code &&
          row.code
            .toLocaleLowerCase()
            .includes(term.code.contains.toLocaleLowerCase())),
    )
  )
    return false;
  if (where.AND && !where.AND.every((term) => matches(row, term))) return false;
  if (where.productions) {
    const predicate = where.productions.some ?? where.productions.none;
    if (!predicate) throw new Error('Expected a production relation filter');
    const exists = row.batches.some(
      (item) =>
        item.manufacturerId === row.id &&
        (predicate.isExternal === undefined ||
          item.isExternal === predicate.isExternal) &&
        (predicate.status === undefined || item.status === predicate.status) &&
        (predicate.debtAmount === undefined ||
          item.debtAmount > predicate.debtAmount.gt),
    );
    if (where.productions.some ? !exists : exists) return false;
  }
  return true;
}

describe('manufacturer filtering business cases (mock repository, no database)', () => {
  const manufacturer = {
    findMany: jest.fn(({ where, skip, take }: ListArgs) =>
      Promise.resolve(
        fixtures.filter((row) => matches(row, where)).slice(skip, skip + take),
      ),
    ),
    count: jest.fn(({ where }: { where: ManufacturerWhere }) =>
      Promise.resolve(fixtures.filter((row) => matches(row, where)).length),
    ),
  };
  const service = new ManufacturersService({
    manufacturer,
  } as unknown as PrismaService);
  const states = [undefined, true, false];
  const combinations = states.flatMap((isActive) =>
    states.flatMap((hasInProgress) =>
      states.map((hasDebt) => ({ isActive, hasInProgress, hasDebt })),
    ),
  );

  beforeEach(() => jest.clearAllMocks());

  it.each(combinations)(
    'matches the independent truth table and total: %j',
    async ({ isActive, hasInProgress, hasDebt }) => {
      const expected = fixtures.filter((row) => {
        const ongoing = [2, 4, 7].includes(row.id);
        const indebted = [3, 4, 7, 8, 11].includes(row.id);
        return (
          (isActive === undefined || row.isActive === isActive) &&
          (hasInProgress === undefined || ongoing === hasInProgress) &&
          (hasDebt === undefined || indebted === hasDebt)
        );
      });
      const result = await service.list('', true, 100, 0, isActive, {
        hasInProgress,
        hasDebt,
      });
      expect(result.data.map((row) => row.id)).toEqual(
        expected.map((row) => row.id),
      );
      expect(result.total).toBe(expected.length);
    },
  );

  it('combines name/code search with debt and paginates after filtering', async () => {
    const first = await service.list('NSX00', true, 2, 0, undefined, {
      hasDebt: true,
    });
    const second = await service.list('NSX00', true, 2, 2, undefined, {
      hasDebt: true,
    });
    expect(first.data.map((row) => row.id)).toEqual([3, 4]);
    expect(second.data.map((row) => row.id)).toEqual([7, 8]);
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(
      (
        await service.list('Ứng trước', true, 10, 0, undefined, {
          hasDebt: true,
        })
      ).data.map((row) => row.id),
    ).toEqual([8]);
  });

  it('does not spread debt among manufacturers linked to the same supplier or follow a changed link', async () => {
    const result = await service.list('', true, 100, 0, undefined, {
      hasDebt: true,
    });
    expect(result.data.map((row) => row.id)).toContain(3);
    expect(result.data.map((row) => row.id)).not.toContain(1);
    expect(result.data.map((row) => row.id)).not.toContain(9);
  });

  it('updates eligibility after receipt, allocation, or cancellation without calculating net partner credit', async () => {
    const row = fixtures.find((item) => item.id === 8)!;
    const original = row.batches[0];
    try {
      row.batches[0] = { ...original, debtAmount: 0 };
      expect(
        (
          await service.list('NSX008', true, 100, 0, undefined, {
            hasDebt: true,
          })
        ).total,
      ).toBe(0);
      row.batches[0] = { ...original, status: 4, debtAmount: 0 };
      expect(
        (
          await service.list('NSX008', true, 100, 0, undefined, {
            hasInProgress: true,
          })
        ).total,
      ).toBe(1);
      row.batches[0] = { ...original, status: 3 };
      expect(
        (
          await service.list('NSX008', true, 100, 0, undefined, {
            hasDebt: false,
            hasInProgress: false,
          })
        ).total,
      ).toBe(1);
    } finally {
      row.batches[0] = original;
    }
  });
});
