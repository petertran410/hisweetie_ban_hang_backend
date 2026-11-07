import {
  avgBy,
  avgHours,
  buildCskhRows,
  buildFunnel,
  buildKpis,
  buildLeadWhere,
  buildSaleRows,
  buildSourceRows,
  buildTrend,
  changePct,
  conversionRate,
  failedHandoverStep,
  periodLabel,
  previousRange,
  ratePct,
  REACHED,
} from './lead-reports.calc';

// Mốc giờ VN (UTC+7) → Date
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('số học', () => {
  it('changePct: null khi kỳ trước = 0 hoặc thiếu số', () => {
    expect(changePct(312, 287)).toBe(8.7);
    expect(changePct(47, 55)).toBe(-14.5);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(null, 10)).toBeNull();
    expect(changePct(10, null)).toBeNull();
  });

  it('ratePct: 0 khi mẫu số = 0', () => {
    expect(ratePct(74, 240)).toBe(30.8);
    expect(ratePct(3, 0)).toBe(0);
  });

  it('avgHours bỏ cặp âm, null khi rỗng', () => {
    expect(
      avgHours([
        [vn('2026-10-01T08:00:00'), vn('2026-10-02T08:00:00')],
        [vn('2026-10-01T08:00:00'), vn('2026-10-01T20:00:00')],
        [vn('2026-10-05T00:00:00'), vn('2026-10-04T00:00:00')],
      ]),
    ).toBe(18);
    expect(avgHours([])).toBeNull();
  });

  it('avgBy gom trung bình theo nhóm', () => {
    const m = avgBy<number | null>([
      [1, 10],
      [1, 20],
      [null, 5],
    ]);
    expect(m.get(1)).toBe(15);
    expect(m.get(null)).toBe(5);
  });
});

describe('tỷ lệ chuyển đổi = đã chuyển đổi / (tổng − huỷ)', () => {
  const status = {
    new: 47,
    caring: 58,
    handed_over: 61,
    converted: 74,
    cancelled: 72,
  };

  it('loại lead Huỷ khỏi mẫu số', () => {
    expect(conversionRate(status)).toBe(30.8); // 74 / 240
  });

  it('chỉ toàn lead huỷ → 0, không chia cho 0', () => {
    expect(conversionRate({ cancelled: 3 })).toBe(0);
  });

  it('buildKpis: so với kỳ trước + tỷ lệ tham khảo trên tổng lead', () => {
    const k = buildKpis(
      { status, avgHoursToHandover: 43.2, avgHoursToFirstOrder: null },
      {
        status: {
          new: 55,
          caring: 52,
          handed_over: 58,
          converted: 63,
          cancelled: 59,
        },
        avgHoursToHandover: 50.4,
        avgHoursToFirstOrder: 168,
      },
    );
    expect(k.total).toEqual({ value: 312, previous: 287, changePct: 8.7 });
    expect(k.newLeads.value).toBe(47);
    expect(k.converted).toEqual({ value: 74, previous: 63, changePct: 17.5 });
    expect(k.conversionRate.value).toBe(30.8);
    expect(k.conversionRate.previous).toBe(27.6); // 63 / (287 − 59)
    expect(k.conversionRate.rateOfAllLeads).toBe(23.7); // 74 / 312
    expect(k.avgHoursToHandover).toEqual({
      value: 43.2,
      previous: 50.4,
      changePct: -14.3,
    });
    expect(k.avgHoursToFirstOrder).toEqual({
      value: null,
      previous: 168,
      changePct: null,
    });
  });

  it('buildKpis không có kỳ trước (Toàn thời gian)', () => {
    const k = buildKpis(
      {
        status: { new: 2 },
        avgHoursToHandover: null,
        avgHoursToFirstOrder: null,
      },
      null,
    );
    expect(k.total).toEqual({ value: 2, previous: 0, changePct: null });
    expect(k.caring).toEqual({ value: 0, previous: 0, changePct: null });
    expect(k.avgHoursToHandover.previous).toBeNull();
  });
});

describe('phễu', () => {
  it('tỷ lệ so với tầng đầu và tỷ lệ rơi từng tầng', () => {
    const f = buildFunnel({
      lead: 312,
      caring: 235,
      handed_over: 165,
      has_customer: 128,
      ordered: 74,
    });
    expect(f.map((s) => s.count)).toEqual([312, 235, 165, 128, 74]);
    expect(f[0]).toMatchObject({
      pctOfTop: 100,
      dropPct: null,
      dropCount: null,
    });
    expect(f[1]).toMatchObject({
      pctOfTop: 75.3,
      dropPct: 24.7,
      dropCount: 77,
    });
    expect(f[4]).toMatchObject({
      pctOfTop: 23.7,
      dropPct: 42.2,
      dropCount: 54,
    });
  });

  it('không có lead → 0%, không NaN', () => {
    const f = buildFunnel({
      lead: 0,
      caring: 0,
      handed_over: 0,
      has_customer: 0,
      ordered: 0,
    });
    expect(f.every((s) => s.pctOfTop === 0)).toBe(true);
    expect(f[1].dropPct).toBe(0);
  });
});

describe('nguồn / nhân sự', () => {
  it('buildSourceRows: thứ tự cố định, bỏ nguồn trống, tỷ lệ loại huỷ', () => {
    const rows = buildSourceRows({
      leads: new Map([
        ['tiktok', 10],
        ['facebook', 30],
      ]),
      converted: new Map([['facebook', 6]]),
      cancelled: new Map([['facebook', 10]]),
      previous: new Map([
        ['facebook', 20],
        ['website', 4],
      ]),
    });
    expect(rows.map((r) => r.source)).toEqual([
      'facebook',
      'tiktok',
      'website',
    ]);
    expect(rows[0]).toMatchObject({
      leads: 30,
      converted: 6,
      conversionRate: 30, // 6 / (30 − 10)
      sharePct: 75,
      leadsChangePct: 50,
    });
    expect(rows[2]).toMatchObject({
      leads: 0,
      previousLeads: 4,
      leadsChangePct: -100,
    });
  });

  it('buildSourceRows không có kỳ trước → leadsChangePct null', () => {
    const rows = buildSourceRows({
      leads: new Map([['shopee', 3]]),
      converted: new Map(),
      cancelled: new Map(),
      previous: null,
    });
    expect(rows[0].leadsChangePct).toBeNull();
  });

  it('buildCskhRows: có dòng "Chưa gán CSKH", có cả người chỉ có tồn đọng', () => {
    const rows = buildCskhRows({
      received: new Map<number | null, number>([
        [12, 10],
        [null, 3],
      ]),
      cared: new Map([[12, 8]]),
      handedOver: new Map([[12, 5]]),
      converted: new Map([[12, 2]]),
      cancelled: new Map([[12, 2]]),
      overdueNew: new Map<number | null, number>([
        [15, 2],
        [null, 1],
      ]),
      firstResponseMinutes: new Map([[12, 38]]),
      names: new Map([
        [12, 'Lan'],
        [15, 'Thư'],
      ]),
    });
    expect(rows[0]).toMatchObject({
      userId: 12,
      name: 'Lan',
      received: 10,
      conversionRate: 25, // 2 / (10 − 2)
      avgFirstResponseMinutes: 38,
    });
    expect(rows.find((r) => r.userId === 0)).toMatchObject({
      name: 'Chưa gán CSKH',
      received: 3,
      overdueNew: 1,
    });
    expect(rows.find((r) => r.userId === 15)).toMatchObject({
      received: 0,
      overdueNew: 2,
      avgFirstResponseMinutes: null,
    });
  });

  it('buildSaleRows: bỏ lead chưa có Sale PIC', () => {
    const rows = buildSaleRows({
      received: new Map<number | null, number>([
        [31, 4],
        [null, 9],
      ]),
      withCustomer: new Map([[31, 3]]),
      ordered: new Map([[31, 2]]),
      cancelled: new Map(),
      overdueNoOrder: new Map([[31, 1]]),
      avgDaysToFirstOrder: new Map([[31, 5.2]]),
      names: new Map([[31, 'Việt']]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 31,
      name: 'Việt',
      conversionRate: 50,
      avgDaysToFirstOrder: 5.2,
      overdueNoOrder: 1,
    });
  });
});

describe('kỳ so sánh (giờ VN)', () => {
  it('trọn tháng → trọn tháng trước', () => {
    const r = {
      from: vn('2026-10-01T00:00:00'),
      to: vn('2026-10-31T23:59:59'),
    };
    expect(periodLabel(r)).toBe('Tháng 10/2026');
    const p = previousRange(r);
    expect(p.from).toEqual(vn('2026-09-01T00:00:00'));
    expect(p.to).toEqual(new Date(vn('2026-10-01T00:00:00').getTime() - 1));
    expect(periodLabel(p)).toBe('Tháng 9/2026');
  });

  it('"Tháng này" dở dang → cùng khoảng ngày của tháng trước', () => {
    const r = {
      from: vn('2026-11-01T00:00:00'),
      to: vn('2026-11-07T12:00:00'),
    };
    const p = previousRange(r);
    expect(p.from).toEqual(vn('2026-10-01T00:00:00'));
    expect(p.to).toEqual(vn('2026-10-07T12:00:00'));
    expect(periodLabel(r)).toBe('01/11/2026 – 07/11/2026');
  });

  it('tháng 3 → tháng 2 không tràn ngày', () => {
    const p = previousRange({
      from: vn('2026-03-01T00:00:00'),
      to: vn('2026-03-31T23:59:59.999'),
    });
    expect(periodLabel(p)).toBe('Tháng 2/2026');
  });

  it('khoảng tuỳ chọn → khoảng cùng độ dài ngay trước', () => {
    const r = {
      from: vn('2026-10-10T00:00:00'),
      to: vn('2026-10-16T23:59:59.999'),
    };
    const p = previousRange(r);
    expect(p.to.getTime()).toBe(r.from.getTime() - 1);
    expect(p.from).toEqual(vn('2026-10-03T00:00:00'));
  });

  it('không có kỳ → "Toàn thời gian"', () => {
    expect(periodLabel(null)).toBe('Toàn thời gian');
  });
});

describe('xu hướng', () => {
  const rows = [
    { createdAt: vn('2026-10-01T09:00:00'), status: 'new' },
    { createdAt: vn('2026-10-01T23:30:00'), status: 'converted' }, // 16:30 UTC, vẫn là 01/10 giờ VN
    { createdAt: vn('2026-10-05T08:00:00'), status: 'converted' },
    { createdAt: vn('2026-10-31T10:00:00'), status: 'cancelled' },
  ];
  const range = {
    from: vn('2026-10-01T00:00:00'),
    to: vn('2026-10-31T23:59:59'),
  };
  const t = buildTrend(rows, range, vn('2026-11-07T10:00:00'));

  it('theo ngày giờ VN, đủ mọi ngày trong kỳ', () => {
    expect(t.day).toHaveLength(31);
    expect(t.day[0]).toEqual({
      key: '2026-10-01',
      label: '01/10',
      newLeads: 2,
      converted: 1,
    });
    expect(t.day[1].newLeads).toBe(0);
    expect(t.day.reduce((s, p) => s + p.newLeads, 0)).toBe(4);
  });

  it('theo tuần ISO và theo tháng, tổng khớp theo ngày', () => {
    expect(t.week.map((w) => w.key)).toEqual([
      '2026-W40',
      '2026-W41',
      '2026-W42',
      '2026-W43',
      '2026-W44',
    ]);
    expect(t.week[0]).toMatchObject({
      label: '01–04/10',
      newLeads: 2,
      converted: 1,
    });
    expect(t.week[1]).toMatchObject({ newLeads: 1, converted: 1 });
    expect(t.month).toEqual([
      { key: '2026-10', label: 'T10/2026', newLeads: 4, converted: 2 },
    ]);
  });

  it('kỳ kéo tới tương lai → cắt ở thời điểm hiện tại', () => {
    const t2 = buildTrend([], range, vn('2026-10-03T10:00:00'));
    expect(t2.day.map((d) => d.key)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });

  it('toàn thời gian, không có lead → rỗng', () => {
    expect(buildTrend([], null, new Date())).toEqual({
      day: [],
      week: [],
      month: [],
    });
  });
});

describe('bộ lọc (cùng quy tắc GET /leads)', () => {
  const cskh = { id: 1, ownOnly: false };
  const sale = { id: 9, ownOnly: true };

  it('Sale chỉ thấy lead có salePicId = mình', () => {
    expect(buildLeadWhere({}, sale)).toEqual({ AND: [{ salePicId: 9 }] });
  });

  it('CSKH không lọc gì → mọi lead', () => {
    expect(buildLeadWhere({}, cskh)).toEqual({});
  });

  it('Sale lọc Sale PIC khác → vẫn giữ điều kiện của mình (ra rỗng, như GET /leads)', () => {
    const w = buildLeadWhere({ salePicId: 31 }, sale);
    expect(w).toEqual({ AND: [{ salePicId: 9 }, { salePicId: 31 }] });
  });

  it('đủ bộ lọc + bỏ kỳ cho khối tồn đọng', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-31T00:00:00Z');
    const f = {
      from,
      to,
      sources: ['facebook'],
      categories: ['cafe', 'chain'],
      cskhUserId: 12,
      salePicId: 31,
    };
    expect(buildLeadWhere(f, cskh)).toEqual({
      AND: [
        { source: { in: ['facebook'] } },
        { category: { in: ['cafe', 'chain'] } },
        { cskhUserId: 12 },
        { salePicId: 31 },
        { createdAt: { gte: from } },
        { createdAt: { lte: to } },
      ],
    });
    expect(
      (buildLeadWhere(f, cskh, false).AND as unknown[]).some(
        (c) => 'createdAt' in (c as object),
      ),
    ).toBe(false);
  });
});

describe('chuyển giao lỗi', () => {
  it('lấy bước failed đầu tiên theo thứ tự lark → friend → greeting', () => {
    expect(
      failedHandoverStep({
        lark: { status: 'ok' },
        friend: { status: 'failed', error: 'Không tìm thấy Zalo của SĐT' },
        greeting: { status: 'failed', error: 'x' },
      }),
    ).toEqual({ step: 'friend', error: 'Không tìm thấy Zalo của SĐT' });
  });

  it('pending / skipped không tính là lỗi', () => {
    expect(
      failedHandoverStep({
        lark: { status: 'ok' },
        friend: { status: 'skipped', error: 'đã là bạn bè' },
        greeting: { status: 'pending' },
      }),
    ).toBeNull();
    expect(failedHandoverStep(null)).toBeNull();
  });
});

describe('điều kiện tầng phễu', () => {
  const conds = (k: keyof typeof REACHED) => {
    const or = REACHED[k].OR;
    return (Array.isArray(or) ? or : []).map((c) => JSON.stringify(c));
  };

  it('mỗi tầng gộp mọi điều kiện của tầng sau → phễu không thể tăng', () => {
    const order = ['caring', 'handed_over', 'has_customer', 'ordered'] as const;
    for (let i = 0; i < order.length - 1; i++) {
      expect(conds(order[i])).toEqual(
        expect.arrayContaining(conds(order[i + 1])),
      );
    }
  });

  it('lead còn "Mới" nhưng đã có chuyển giao vẫn tính là đã chăm sóc', () => {
    expect(conds('caring')).toContain(
      JSON.stringify({ handovers: { some: {} } }),
    );
  });
});

describe('nhãn tuần', () => {
  it('tuần chỉ có 1 ngày trong kỳ → nhãn 1 ngày', () => {
    const t = buildTrend(
      [],
      { from: vn('2026-11-01T00:00:00'), to: vn('2026-11-07T10:00:00') },
      vn('2026-11-07T12:00:00'),
    );
    expect(t.week.map((w) => w.label)).toEqual(['01/11', '02–07/11']);
  });
});
