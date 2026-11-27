import {
  buildDailyCard,
  channelLabel,
  dailyReportUrl,
  DailyReportService,
  findDiscrepancies,
  type DailyReport,
} from './daily-report.service';

const PRODUCTS = [
  {
    id: 1,
    code: 'MBL',
    name: 'Gấu Lermao - Matcha Bạch Lan 500gr',
    unit: 'Gói',
  },
  { id: 2, code: 'TL', name: 'Trà lài Phượng Hoàng 500gr', unit: 'Gói' },
];

describe('findDiscrepancies', () => {
  it('giá viết tắt nghìn đồng ("330") quy về đồng; chênh < 5% không tính là lệch', () => {
    const result = findDiscrepancies(
      [
        { product: 'matcha bạch lan', price: 330, customer: 'A', channel: 'K' },
        {
          product: 'matcha bạch lan',
          price: 330000,
          customer: 'B',
          channel: 'K',
        },
        { product: 'trà lài', price: 115000, customer: 'C', channel: 'K' },
        { product: 'trà lài', price: 118000, customer: 'D', channel: 'K' },
      ],
      PRODUCTS,
    );
    expect(result).toEqual([]);
  });

  it('cùng sản phẩm, ≥ 2 mức giá → lệch; một mức giá → không', () => {
    const result = findDiscrepancies(
      [
        {
          product: 'matcha bạch lan',
          price: 330000,
          customer: 'Ms Hải Triều',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'Matcha Bạch Lan 500gr',
          price: 400000,
          customer: 'Lê Duy Minh',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'trà lài',
          price: 115000,
          customer: 'Mr Viễn',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'trà lài',
          price: 115000,
          customer: 'Chị Huệ',
          channel: 'Diệp Trà Cs',
        },
      ],
      PRODUCTS,
    );
    expect(result).toEqual([
      {
        product: 'Gấu Lermao - Matcha Bạch Lan 500gr',
        prices: [
          { price: 330000, customer: 'Ms Hải Triều', channel: 'Ms Mai Phương' },
          { price: 400000, customer: 'Lê Duy Minh', channel: 'Ms Mai Phương' },
        ],
      },
    ]);
  });
});

const REPORT: DailyReport = {
  day: '2026-11-22',
  stats: { channels: 7, threads: 86, messages: 900 },
  complaints: [
    {
      customer: 'Mr Nhật Anh',
      channel: 'Ms Mai Phương',
      issue: 'Trái cây có sâu',
      handled: false,
    },
  ],
  pending: [
    {
      customer: 'Tiệm bánh Hazen',
      channel: 'Ms Mai Phương',
      request: 'Chưa nhận được hàng',
      since: '09:10',
    },
  ],
  discrepancies: [],
  model: 'm',
  tokens: 1,
};

describe('dailyReportUrl', () => {
  it('chỉ gắn link khi địa chỉ POS là https', () => {
    expect(dailyReportUrl('2026-11-23', 'https://pos.example/')).toBe('https://pos.example/bao-cao/smax?tab=cuoi-ngay&ngay=2026-11-23');
    expect(dailyReportUrl('2026-11-23', 'http://localhost:3050')).toBeNull();
    expect(dailyReportUrl('2026-11-23', '')).toBeNull();
  });
  it('card: "Còn N mục khác" trỏ link POS', () => {
    const pending = Array.from({ length: 12 }, () => REPORT.pending[0]);
    const card = JSON.stringify(buildDailyCard({ ...REPORT, pending }, 'https://pos.example/x'));
    expect(card).toContain('[xem danh sách đầy đủ trên POS](https://pos.example/x)');
  });
});

describe('channelLabel', () => {
  it('loại kênh + tên kênh', () => {
    expect(channelLabel({ platform: 'facebook', name: 'LerMao - Sành Ăn Như Gấu' })).toBe('Facebook · LerMao - Sành Ăn Như Gấu');
    expect(channelLabel({ platform: 'zaloweb', name: 'Diệp Trà - Ms Mai Phương' })).toBe('Zalo cá nhân · Diệp Trà - Ms Mai Phương');
    expect(channelLabel({ platform: 'tiktokweb', name: 'Gấu LerMao' })).toBe('TikTok · Gấu LerMao');
    expect(channelLabel({ platform: 'shopee', name: 'LerMao Official' })).toBe('Shopee · LerMao Official');
  });
});

describe('buildDailyCard', () => {
  const texts = (card: any): string[] => card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content);

  it('card JSON 2.0 theo mẫu: tiêu đề + ngày, tổng quan, 3 mục ưu tiên, việc cần làm', () => {
    const card: any = buildDailyCard(REPORT);
    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toBe('📊 BÁO CÁO CHAT CUỐI NGÀY');
    expect(card.header.subtitle.content).toBe('22/11/2026 · Báo cáo tự động');
    const all = texts(card).join('\n');
    expect(all).toContain('**86** hội thoại  ·  **900** tin nhắn');
    expect(all).toContain('### 🔴 ƯU TIÊN 1 · KHIẾU NẠI CHƯA XỬ LÝ (1)');
    expect(all).toContain('<font color="grey">(Ms Mai Phương)</font> — Trái cây có sâu.');
    expect(all).toContain('**Tiệm bánh Hazen** <font color="grey">(Ms Mai Phương)</font> · **09:10** — Chưa nhận được hàng.');
    expect(all).toContain('### 💰 ƯU TIÊN 3 · CẢNH BÁO GIÁ (0)\nKhông có.');
    // Không có cảnh báo giá → bỏ việc "Đối chiếu", đánh số liền
    const todo = texts(card).find((t) => t.startsWith('### ✅ VIỆC CẦN LÀM'))!;
    expect(todo).toContain('2. Phân loại 1 mục');
    expect(todo).toContain('3. Loại tin xác nhận đơn giản');
    expect(todo).not.toContain('Đối chiếu');
  });

  it('nhiều mục: 10 dòng mới nhất trước + "Còn N mục khác"', () => {
    const pending = Array.from({ length: 13 }, (_, i) => ({
      ...REPORT.pending[0],
      request: `Yêu cầu ${i}`,
      since: `${String(8 + i).padStart(2, '0')}:00`,
    }));
    const section = texts(buildDailyCard({ ...REPORT, pending })).find((t) => t.includes('ƯU TIÊN 2'))!;
    const lines = section.split('\n');
    expect(lines[1]).toContain('· **20:00**');
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.at(-1)).toBe('_Còn 3 mục khác — xem danh sách đầy đủ trên POS (Báo cáo › Smax chat › Báo cáo chat cuối ngày)._');
  });
});

describe('DailyReportService.send', () => {
  it('đã gửi trong ngày (có audit) → không gửi lại', async () => {
    const create = jest.fn();
    const service = new DailyReportService(
      { auditLog: { count: jest.fn().mockResolvedValue(1) } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { im: { message: { create } } } as any,
    );
    await expect(service.send('2026-11-22')).resolves.toEqual({
      sent: false,
      reason: 'already_sent',
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('DailyReportService.sendPreview', () => {
  const make = () => {
    const create = jest.fn().mockResolvedValue({ code: 0 });
    const audit = { create: jest.fn().mockResolvedValue({}) };
    const service = new DailyReportService(
      {} as any,
      audit as any,
      {} as any,
      {} as any,
      {} as any,
      { im: { message: { create } } } as any,
    );
    return { service, create, audit };
  };

  it('chưa có bản xem trước xong → báo lỗi, không gửi', async () => {
    const { service, create } = make();
    await expect(service.sendPreview({ id: 7, name: 'An' })).rejects.toThrow('Chưa có bản xem trước');
    (service as any).preview = { status: 'running', day: '2026-11-24' };
    await expect(service.sendPreview({ id: 7, name: 'An' })).rejects.toThrow('Chưa có bản xem trước');
    expect(create).not.toHaveBeenCalled();
  });

  it('gửi đúng bản đang xem, ghi audit dưới người bấm; bấm lần 2 không gửi lại', async () => {
    const { service, create, audit } = make();
    (service as any).preview = { status: 'done', day: REPORT.day, report: REPORT };
    const res = await service.sendPreview({ id: 7, name: 'An' });
    expect(res).toMatchObject({ sent: true, day: REPORT.day });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][0].data.content).header.subtitle.content).toContain('22/11/2026');
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, userName: 'An', entityId: REPORT.day, snapshot: REPORT }),
    );
    expect(audit.create.mock.calls[0][0].metadata).toMatchObject({ detail: true, manual: true });
    await expect(service.sendPreview({ id: 7, name: 'An' })).rejects.toThrow('đã gửi');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('DailyReportService.savePreview / savedReports', () => {
  it('lưu bản xem trước: audit AI_DAILY_REPORT_SAVED dưới người bấm, không gửi Lark; lưu lần 2 báo lỗi', async () => {
    const create = jest.fn();
    const audit = { create: jest.fn().mockResolvedValue({}) };
    const service = new DailyReportService({} as any, audit as any, {} as any, {} as any, {} as any, {
      im: { message: { create } },
    } as any);
    await expect(service.savePreview({ id: 7, name: 'An' })).rejects.toThrow('Chưa có bản xem trước');
    (service as any).preview = { status: 'done', day: REPORT.day, report: REPORT };
    await expect(service.savePreview({ id: 7, name: 'An' })).resolves.toMatchObject({ saved: true, day: REPORT.day });
    expect(create).not.toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'AI_DAILY_REPORT_SAVED', userId: 7, entityId: REPORT.day, snapshot: REPORT }),
    );
    await expect(service.savePreview({ id: 7, name: 'An' })).rejects.toThrow('đã lưu');
  });

  it('danh sách gộp bản đã gửi + đã lưu, đánh dấu sent', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 2, actionCode: 'AI_DAILY_REPORT_SAVED', entityId: '2026-11-24', createdAt: new Date(), metadata: { detail: true, threads: 3 }, userName: 'An' },
      { id: 1, actionCode: 'AI_DAILY_REPORT', entityId: '2026-11-23', createdAt: new Date(), metadata: { threads: 9 }, userName: 'System' },
    ]);
    const service = new DailyReportService({ auditLog: { findMany } } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const list = await service.savedReports();
    expect(list.map((r) => [r.id, r.day, r.sent, r.detail, r.by])).toEqual([
      [2, '2026-11-24', false, true, 'An'],
      [1, '2026-11-23', true, false, 'System'],
    ]);
  });
});

describe('DailyReportService.sendSaved', () => {
  const make = (saved: unknown, sentBefore: unknown = null) => {
    const create = jest.fn().mockResolvedValue({ code: 0 });
    const audit = { create: jest.fn().mockResolvedValue({}) };
    const findFirst = jest.fn().mockImplementation(({ where }: any) =>
      Promise.resolve(where.actionCode === 'AI_DAILY_REPORT_SAVED' ? saved : sentBefore),
    );
    const service = new DailyReportService({ auditLog: { findFirst } } as any, audit as any, {} as any, {} as any, {} as any, {
      im: { message: { create } },
    } as any);
    return { service, create, audit };
  };

  it('gửi đúng nội dung bản đã lưu, audit ghi fromSaved + người bấm', async () => {
    const { service, create, audit } = make({ snapshot: REPORT });
    await expect(service.sendSaved(5, { id: 7, name: 'An' })).resolves.toEqual({ sent: true, day: REPORT.day });
    expect(create).toHaveBeenCalledTimes(1);
    expect(audit.create.mock.calls[0][0]).toMatchObject({
      actionCode: 'AI_DAILY_REPORT',
      userId: 7,
      metadata: { fromSaved: 5, manual: true },
    });
  });

  it('không có bản lưu / bản lưu đã gửi → báo lỗi, không gửi', async () => {
    const a = make(null);
    await expect(a.service.sendSaved(5, { id: 7, name: 'An' })).rejects.toThrow('Không tìm thấy');
    const b = make({ snapshot: REPORT }, { createdAt: new Date() });
    await expect(b.service.sendSaved(5, { id: 7, name: 'An' })).rejects.toThrow('đã gửi');
    expect(a.create).not.toHaveBeenCalled();
    expect(b.create).not.toHaveBeenCalled();
  });
});

describe('DailyReportService.build + nhãn AI từng tin (Message Intelligence)', () => {
  const make = (intel?: object, rows: { pagePid: string; tid: string; msgPid: string }[] = [], tids = ['a', 'b', 'c']) => {
    const service = new DailyReportService(
      {
        product: { findMany: jest.fn().mockResolvedValue([]) },
        smaxMessage: { findMany: jest.fn().mockResolvedValue(rows) },
      } as any,
      {} as any,
      { listPages: jest.fn().mockResolvedValue([{ pid: 'p1', name: 'Ms Mai Phương', platform: 'zaloweb' }]) } as any,
      {} as any,
      {} as any,
      {} as any,
      {
        covered: jest.fn().mockResolvedValue(true),
        threadsInRange: jest.fn().mockResolvedValue(tids.map((tid) => ({ pagePid: 'p1', tid, name: tid }))),
      } as any,
      intel as any,
    );
    const threadText = jest.spyOn(service as any, 'threadText').mockResolvedValue(null);
    return { service, threadText };
  };
  afterEach(() => delete process.env.AI_DAILY_REPORT_MAX_THREADS);

  it('hội thoại có tin khiếu nại / bất thường lên trước (trần số hội thoại không cắt mất); stats kèm độ phủ', async () => {
    process.env.AI_DAILY_REPORT_MAX_THREADS = '1';
    const { service, threadText } = make({
      dailySignals: jest.fn().mockResolvedValue({
        flaggedThreads: new Set(['p1:c']),
        coverage: 0.6,
        customerMessages: 10,
        labeled: 6,
        complaints: 2,
        anomalies: 1,
        escalations: 0,
      }),
    });
    const report = await service.build('2026-11-27');
    expect(threadText).toHaveBeenCalledTimes(1);
    expect((threadText.mock.calls[0] as [{ tid: string }])[0].tid).toBe('c');
    expect(report.stats).toMatchObject({ skipped: 2, intel: { complaints: 2, anomalies: 1, escalations: 0, coverage: 0.6 } });
    expect(report.stats.merged).toBeUndefined();
  });

  it('chưa bật phân loại tin → giữ thứ tự cũ, không có số liệu nhãn', async () => {
    process.env.AI_DAILY_REPORT_MAX_THREADS = '1';
    const { service, threadText } = make(undefined);
    const report = await service.build('2026-11-27');
    expect((threadText.mock.calls[0] as [{ tid: string }])[0].tid).toBe('a');
    expect(report.stats.intel).toBeUndefined();
  });

  it('gộp hội thoại trùng (cùng nhóm ở nhiều kênh = chung tin): phân tích 1 lần, giữ bản nhiều tin nhất', async () => {
    // a và c là cùng 1 nhóm (chung m1); c có nhiều tin hơn trong ngày → giữ c; b riêng
    const rows = [
      { pagePid: 'p1', tid: 'a', msgPid: 'm1' },
      { pagePid: 'p1', tid: 'c', msgPid: 'm1' },
      { pagePid: 'p1', tid: 'c', msgPid: 'm2' },
      { pagePid: 'p1', tid: 'b', msgPid: 'm9' },
    ];
    const { service, threadText } = make(undefined, rows);
    const report = await service.build('2026-11-27');
    expect(threadText.mock.calls.map((c) => (c as [{ tid: string }])[0].tid)).toEqual(['b', 'c']);
    expect(report.stats).toMatchObject({ merged: 1 });
    expect(report.stats.skipped).toBeUndefined();
  });

  it('card: dòng nhãn AI, độ phủ thấp ghi "chưa đầy đủ"', () => {
    const texts = (card: any): string[] => card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content);
    const low = texts(buildDailyCard({ ...REPORT, stats: { ...REPORT.stats, intel: { complaints: 2, anomalies: 1, escalations: 0, coverage: 0.6 } } })).join('\n');
    expect(low).toContain('🤖 AI phân loại từng tin: 2 khiếu nại · 1 bất thường · 0 cần quản lý (đã gắn nhãn 60% tin khách, chưa đầy đủ)');
    const full = texts(buildDailyCard({ ...REPORT, stats: { ...REPORT.stats, intel: { complaints: 0, anomalies: 0, escalations: 0, coverage: 0.99 } } })).join('\n');
    expect(full).toContain('(đã gắn nhãn 99% tin khách)');
    expect(texts(buildDailyCard(REPORT)).join('\n')).not.toContain('🤖');
    expect(texts(buildDailyCard({ ...REPORT, stats: { ...REPORT.stats, merged: 1908 } })).join('\n')).toContain('đã gộp 1.908 bản trùng giữa các kênh');
  });
});
