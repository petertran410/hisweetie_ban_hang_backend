import {
  buildChannelRows,
  buildFunnel,
  buildStaffRows,
  buildThreadStats,
  buildTrend,
  csvInts,
  rateKpi,
  vnDayKey,
  vnStartOfDay,
} from './smax-reports.calc';
import { SmaxReportsService } from './smax-reports.service';

const send = (o: Partial<Parameters<typeof buildStaffRows>[0][number]>) => ({
  userId: 1,
  userName: 'A',
  pagePid: 'p1',
  day: '2026-11-02',
  messages: 1,
  group: 0,
  failures: 0,
  ...o,
});

describe('smax-reports.calc', () => {
  it('vnDayKey / vnStartOfDay theo giờ Việt Nam', () => {
    // 18:00Z ngày 1 = 01:00 ngày 2 giờ VN
    expect(vnDayKey(new Date('2026-11-01T18:00:00Z'))).toBe('2026-11-02');
    expect(vnStartOfDay(new Date('2026-11-01T18:00:00Z')).toISOString()).toBe(
      '2026-11-01T17:00:00.000Z',
    );
  });

  it('csvInts bỏ giá trị rác', () => {
    expect(csvInts('1, 2,x,,-3,4')).toEqual([1, 2, 4]);
  });

  it('rateKpi: tỉ lệ %, so kỳ trước; kỳ trước 0 → changePct null', () => {
    expect(rateKpi(369, 1293, { num: 1, den: 4 })).toMatchObject({
      value: 28.5,
      previous: 25,
      changePct: 14,
      num: 369,
      den: 1293,
    });
    expect(rateKpi(1, 2, { num: 0, den: 5 }).changePct).toBeNull();
    expect(rateKpi(0, 0, null)).toMatchObject({ value: 0, previous: null });
  });

  it('buildTrend điền 0 cho ngày trống và chia trực tiếp / nhóm', () => {
    const trend = buildTrend(
      [
        { day: '2026-11-01', messages: 3, group: 1 },
        { day: '2026-11-03', messages: 2, group: 2 },
      ],
      [{ day: '2026-11-02', n: 4 }],
      {
        from: new Date('2026-10-31T17:00:00Z'),
        to: new Date('2026-11-30T16:59:59Z'),
      },
      new Date('2026-11-03T05:00:00Z'),
    );
    expect(
      trend.map((t) => [t.key, t.messages, t.direct, t.group, t.links]),
    ).toEqual([
      ['2026-11-01', 3, 2, 1, 0],
      ['2026-11-02', 0, 0, 0, 4],
      ['2026-11-03', 2, 0, 2, 0],
    ]);
    expect(trend[0].label).toBe('01/11');
  });

  it('buildFunnel tính % theo tầng đầu', () => {
    expect(
      buildFunnel({ leads: 200, handedOver: 150, converted: 50 }).map(
        (s) => s.pct,
      ),
    ).toEqual([100, 75, 25]);
    expect(buildFunnel({ leads: 0, handedOver: 0, converted: 0 })[0].pct).toBe(
      0,
    );
  });

  it('buildThreadStats: renew = có tin cuối trong kỳ − tạo trong kỳ, không âm', () => {
    const { stats, byChannel } = buildThreadStats(
      [
        {
          pagePid: 'a',
          created: 10,
          createdGroup: 4,
          active: 25,
          activeGroup: 9,
        },
        {
          pagePid: 'b',
          created: 5,
          createdGroup: 0,
          active: 3,
          activeGroup: 0,
        },
      ],
      true,
    );
    expect(stats).toMatchObject({
      available: true,
      newTotal: 15,
      newGroup: 4,
      newDirect: 11,
      renewTotal: 15,
      renewGroup: 5,
      renewDirect: 10,
      partial: true,
    });
    expect(byChannel.get('b')).toEqual({ newTotal: 5, renewTotal: 0 });
  });

  it('bảng nhân viên / kênh gộp tin, lượt gắn, đơn', () => {
    const sends = [
      send({ userId: 1, messages: 5, group: 2, failures: 1 }),
      send({ userId: 1, pagePid: 'p2', messages: 1 }),
      send({ userId: 2, userName: 'B', messages: 8 }),
    ];
    const links = [
      { userId: 1, pagePid: 'p1', day: '2026-11-02', n: 3 },
      { userId: 3, pagePid: null, day: '2026-11-02', n: 2 },
    ];
    const staff = buildStaffRows(
      sends,
      links,
      [
        {
          userId: 1,
          chattedCustomers: 4,
          customersWithOrder: 2,
          revenue: 1_000_000,
        },
      ],
      new Map([[3, 'C']]),
    );
    expect(
      staff.map((r) => [
        r.userId,
        r.name,
        r.messages,
        r.direct,
        r.group,
        r.links,
      ]),
    ).toEqual([
      [2, 'B', 8, 8, 0, 0],
      [1, 'A', 6, 4, 2, 3],
      [3, 'C', 0, 0, 0, 2],
    ]);
    expect(staff[1]).toMatchObject({
      failures: 1,
      customersWithOrder: 2,
      revenue: 1_000_000,
    });

    const channels = buildChannelRows(
      sends,
      links,
      [{ pagePid: 'p1', name: 'Kênh 1', platform: 'zaloweb' }],
      new Map([
        ['p1', { newTotal: 7, renewTotal: 2 }],
        ['p3', { newTotal: 1, renewTotal: 0 }],
      ]),
    );
    expect(
      channels.map((c) => [
        c.pagePid,
        c.name,
        c.messages,
        c.links,
        c.newThreads,
      ]),
    ).toEqual([
      ['p1', 'Kênh 1', 13, 3, 7],
      ['p2', 'p2', 1, 0, null],
      ['p3', 'p3', 0, 0, 1],
    ]);
  });
});

/** Prisma giả: ghi lại mọi câu SQL, trả số 0 / rỗng. */
function fakePrisma() {
  const sqls: string[] = [];
  const raw = jest.fn(
    async (
      strings: TemplateStringsArray | { strings?: string[]; sql?: string },
      ...values: any[]
    ) => {
      const text = Array.isArray(strings)
        ? strings.join('?') +
          values
            .map((v) => (v && typeof v === 'object' && 'sql' in v ? v.sql : ''))
            .join(' ')
        : String((strings as any).sql ?? '');
      sqls.push(text);
      if (/AS day/.test(text)) return [];
      if (/count\(\*\)::int AS den/.test(text)) return [{ num: 0, den: 0 }];
      if (
        /AS "userId", count\(\*\)::int AS "chattedCustomers"/.test(text) &&
        !/0 AS "userId"/.test(text)
      )
        return [];
      if (/0 AS "userId"/.test(text))
        return [
          {
            userId: 0,
            chattedCustomers: 0,
            customersWithOrder: 0,
            revenue: 0,
            invoices: 0,
          },
        ];
      if (/AS staff/.test(text))
        return [{ messages: 0, staff: 0, failures: 0 }];
      if (/count\(\*\)::int AS n/.test(text)) return [{ n: 0 }];
      return [];
    },
  );
  return {
    sqls,
    prisma: {
      $queryRaw: raw,
      lead: { count: jest.fn(async () => 0) },
      user: { findMany: jest.fn(async () => []) },
      smaxChannelUser: {
        findMany: jest.fn(async () => [{ pagePid: 'mine' }]),
      },
      branch: { findMany: jest.fn(async () => []) },
    },
  };
}

describe('SmaxReportsService', () => {
  const api = () => ({
    listPages: jest.fn(async () => [
      { pid: 'mine', name: 'Kênh của tôi', platform: 'zaloweb' },
      { pid: 'other', name: 'Kênh khác', platform: 'facebook' },
    ]),
    countThreads: jest.fn(async () => 3),
  });
  const q = {
    from: '2026-11-01T00:00:00+07:00',
    to: '2026-11-30T23:59:59.999+07:00',
  };

  it('không bao giờ đọc nội dung tin nhắn (metadata.text)', async () => {
    const { prisma, sqls } = fakePrisma();
    const service = new SmaxReportsService(prisma as any, api() as any);
    await service.summary(q, { id: 1, ownOnly: false, leadsOwnOnly: false });
    expect(sqls.length).toBeGreaterThan(5);
    for (const sql of sqls) expect(sql).not.toMatch(/'text'/);
  });

  it('ownOnly: chỉ kênh được gán, lọc theo chính mình', async () => {
    const { prisma } = fakePrisma();
    const smax = api();
    const service = new SmaxReportsService(prisma as any, smax as any);
    const data = await service.summary(
      { ...q, userId: 99 },
      { id: 7, ownOnly: true, leadsOwnOnly: true },
    );
    expect(data.ownOnly).toBe(true);
    // Chỉ đếm hội thoại kênh của mình (4 lần gọi cho 1 kênh)
    expect(smax.countThreads).toHaveBeenCalledTimes(4);
    expect(
      (smax.countThreads.mock.calls as unknown as [string[]][]).every(
        ([pids]) => pids[0] === 'mine',
      ),
    ).toBe(true);
    // userId lọc là chính người xem, không phải 99
    const params = prisma.$queryRaw.mock.calls.flatMap((c: any[]) =>
      c.slice(1),
    );
    expect(JSON.stringify(params)).toContain('7');
    expect(prisma.lead.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ salePicId: 7 }),
    });
  });

  it('không chọn khoảng ngày → khối hội thoại báo cần chọn kỳ, không gọi Smax', async () => {
    const { prisma } = fakePrisma();
    const smax = api();
    const service = new SmaxReportsService(prisma as any, smax as any);
    const data = await service.summary(
      {},
      { id: 1, ownOnly: false, leadsOwnOnly: false },
    );
    expect(data.threads.available).toBe(false);
    expect(data.threads.note).toContain('Chọn khoảng thời gian');
    expect(smax.countThreads).not.toHaveBeenCalled();
    expect(data.kpis.messages.previous).toBeNull();
  });

  it('Smax lỗi → khối hội thoại không khả dụng, phần còn lại vẫn trả', async () => {
    const { prisma } = fakePrisma();
    const smax = api();
    smax.countThreads.mockRejectedValue(new Error('timeout'));
    const service = new SmaxReportsService(prisma as any, smax as any);
    const data = await service.summary(q, {
      id: 1,
      ownOnly: false,
      leadsOwnOnly: false,
    });
    expect(data.threads).toMatchObject({ available: false });
    expect(data.threads.note).toContain('Smax');
    expect(data.kpis.messages.value).toBe(0);
  });
});
