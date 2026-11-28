import { MessageIntelQueryService } from './message-intel-query.service';

const from = new Date('2026-11-20T00:00:00Z');
const to = new Date('2026-11-28T00:00:00Z');
const g = (o: object, n: number, tokens = 0) => ({
  ...o,
  _count: { _all: n },
  _sum: { inputTokens: tokens },
});

function make() {
  const prisma = {
    smaxMessageIntel: {
      groupBy: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    smaxSyncChannel: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ pagePid: 'zlwA', name: 'Ms Mai Phương' }]),
    },
    smaxMessage: { findMany: jest.fn().mockResolvedValue([]) },
    smaxThread: { findMany: jest.fn().mockResolvedValue([]) },
    smaxIntelReview: {
      upsert: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ topic: 'delivery', n: 3n }]),
  };
  const intel = {
    activeVersion: jest.fn().mockResolvedValue({ id: 2 }),
    ourPagePids: jest.fn().mockResolvedValue(new Set(['zlwA'])),
    consumeTokens: jest.fn(),
  };
  const jev = { classify: jest.fn() };
  return {
    prisma,
    intel,
    jev,
    svc: new MessageIntelQueryService(prisma as any, intel as any, jev as any),
  };
}

describe('MessageIntelQueryService', () => {
  it('độ phủ = đã có kết quả / tin cần hiểu; tin nhân viên không tính, tin chỉ ảnh vẫn tính (chưa hiểu)', async () => {
    const { prisma, svc } = make();
    const byStatus = [
      g(
        { status: 'completed', skipReason: null, processingSource: 'jev' },
        40,
        80_000,
      ),
      g(
        { status: 'completed', skipReason: null, processingSource: 'rule' },
        10,
      ),
      g({ status: 'pending', skipReason: null, processingSource: null }, 30),
      g(
        { status: 'skipped', skipReason: 'staff', processingSource: 'rule' },
        100,
      ),
      g(
        {
          status: 'skipped',
          skipReason: 'media_only',
          processingSource: 'rule',
        },
        20,
      ),
    ];
    prisma.smaxMessageIntel.groupBy
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([
        g({ pagePid: 'zlwA', status: 'completed', skipReason: null }, 50),
        g({ pagePid: 'zlwA', status: 'skipped', skipReason: 'staff' }, 100),
      ])
      .mockResolvedValue([]);
    const o = await svc.overview({ from, to });
    expect(o.totals).toMatchObject({
      messages: 200,
      eligible: 100,
      completed: 50,
      completedByJev: 40,
      completedByRule: 10,
      pending: 30,
      coverage: 0.5,
      inputTokens: 80_000,
    });
    expect(o.skipped).toEqual({ staff: 100, media_only: 20 });
    expect(o.topics).toEqual([{ key: 'delivery', count: 3 }]);
    expect(o.channels[0]).toMatchObject({
      name: 'Ms Mai Phương',
      total: 150,
      eligible: 50,
      completed: 50,
    });
  });

  it('không có quyền xem chat → không đọc / trả nội dung tin', async () => {
    const { prisma, svc } = make();
    prisma.smaxMessageIntel.findMany.mockResolvedValue([
      {
        id: 1n,
        msgPid: 'm1',
        messageId: 11n,
        pagePid: 'zlwA',
        tid: 't',
        messageAt: from,
        status: 'completed',
        topics: [],
        answers: null,
        burstMsgPids: [],
      },
    ]);
    const r = await svc.messages({ from, to, page: 1, limit: 20 }, false);
    expect(prisma.smaxMessage.findMany).not.toHaveBeenCalled();
    expect(r.items[0]).toMatchObject({
      text: null,
      senderName: null,
      channel: 'Ms Mai Phương',
    });
    expect(r.contentVisible).toBe(false);
  });

  it('thử nghiệm: tin chỉ xác nhận dừng ở luật, không gọi Jev / không tốn token', async () => {
    const { jev, intel, svc } = make();
    const r = await svc.sandbox({
      text: 'Dạ ok em',
      isGroup: false,
      previous: [],
    });
    expect(r.rule.status).toBe('completed');
    expect(r.result).toBeNull();
    expect(jev.classify).not.toHaveBeenCalled();
    expect(intel.consumeTokens).not.toHaveBeenCalled();
  });

  it('thử nghiệm: tin cần hiểu → gọi Jev với state đã ẩn danh, cộng token', async () => {
    const { jev, intel, svc } = make();
    jev.classify.mockResolvedValue({
      labels: {},
      answers: {},
      model: 'jev-1.14.0',
      inputTokens: 2000,
      latencyMs: 200,
    });
    const r = await svc.sandbox({
      text: 'Hàng thiếu 2 gói, gọi chị 0912345678',
      isGroup: false,
      previous: [{ role: 'staff', text: 'Dạ em gửi rồi ạ' }],
    });
    const [state] = jev.classify.mock.calls[0] as [
      { target: { text: string }; previous: { role: string }[] },
    ];
    expect(state.target.text).toContain('[SĐT]');
    expect(state.previous).toEqual([
      { role: 'staff', text: 'Dạ em gửi rồi ạ' },
    ]);
    expect(intel.consumeTokens).toHaveBeenCalledWith(2000);
    expect(r.result).not.toBeNull();
  });
});

describe('MessageIntelQueryService.reportMessageFlags', () => {
  it('báo cáo chat: khiếu nại / hỏi giá / tiêu cực → hit; cần trả lời → reply; tin đã gộp theo tin cuối cụm', async () => {
    const { prisma, svc } = make();
    const job = (msgPid: string, over: object = {}) => ({
      msgPid,
      status: 'completed',
      mergedInto: null,
      intent: 'order',
      topics: [],
      sentiment: 'neutral',
      requiresReply: false,
      requiresEscalation: false,
      isAnomaly: false,
      ...over,
    });
    prisma.smaxMessageIntel.findMany.mockResolvedValue([
      job('k1', { intent: 'complaint' }),
      job('g1', { intent: 'price_inquiry' }),
      job('t1', { topics: ['missing_items'] }),
      job('n1', { sentiment: 'negative' }),
      job('r1', { requiresReply: true }),
      job('ok'),
      job('s1', { status: 'skipped', intent: null }),
      job('m1', { status: 'skipped', mergedInto: 'k1', intent: null }),
    ]);
    const flags = (await svc.reportMessageFlags({ from, to }))!;
    expect(['k1', 'g1', 't1', 'n1', 'm1'].every((p) => flags.get(p)!.hit)).toBe(
      true,
    );
    expect(flags.get('r1')).toEqual({ hit: false, reply: true });
    expect(flags.get('ok')).toEqual({ hit: false, reply: false });
    expect(flags.get('s1')).toEqual({ hit: false, reply: false });
  });
});

describe('MessageIntelQueryService.coveredPagePids', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('máy tắt worker (MESSAGE_INTEL_ENABLED=false) vẫn coi kênh đã phân loại khi có phiên bản chạy → ẩn nút "Phân loại"', async () => {
    process.env.MESSAGE_INTEL_ENABLED = 'false';
    delete process.env.MESSAGE_INTEL_PAGE_PIDS;
    const { svc } = make();
    expect(await svc.coveredPagePids(['zlwA', 'zlwB'])).toEqual([
      'zlwA',
      'zlwB',
    ]);
  });

  it('giới hạn theo MESSAGE_INTEL_PAGE_PIDS; chưa có phiên bản chạy → không kênh nào', async () => {
    process.env.MESSAGE_INTEL_PAGE_PIDS = 'zlwA';
    const { svc, intel } = make();
    expect(await svc.coveredPagePids(['zlwA', 'zlwB'])).toEqual(['zlwA']);
    intel.activeVersion.mockResolvedValue(null);
    expect(await svc.coveredPagePids(['zlwA'])).toEqual([]);
  });
});

describe('MessageIntelQueryService.threadLabels', () => {
  const at = (min: number) =>
    new Date(Date.parse('2026-11-27T03:00:00Z') + min * 60_000);
  const row = (min: number, over: object = {}) => ({
    page_pid: 'zlwA',
    tid: 't1',
    created_at: at(min),
    from_me: false,
    status: 'completed',
    skip_reason: null,
    intent: 'other',
    is_anomaly: false,
    requires_reply: false,
    ...over,
  });
  const run = async (rows: object[]) => {
    const { prisma, svc } = make();
    prisma.$queryRaw.mockResolvedValue(rows);
    return (
      await svc.threadLabels([{ pagePid: 'zlwA', tid: 't1' }], at(60))
    ).get('zlwA:t1');
  };

  it('ưu tiên khiếu nại / bất thường hơn đặt hàng trong "cửa sổ mở" (tin khách sau tin nhân viên cuối); khách đang chờ', async () => {
    const l = await run([
      row(1, { intent: 'complaint' }),
      row(2, { from_me: true, status: null }),
      row(3, { intent: 'order', requires_reply: true }),
      row(4, { intent: 'other', is_anomaly: true }),
    ]);
    expect(l).toMatchObject({
      label: 'complaint',
      pending: true,
      stale: false,
    });
    expect(l!.reason).toMatch(/^Bất thường lúc \d{2}:\d{2}$/);
  });

  it('nhân viên đã trả lời sau cùng → không còn chờ; nhãn theo 5 tin khách gần nhất', async () => {
    const l = await run([
      row(1, { intent: 'order', requires_reply: true }),
      row(2, { status: 'skipped', skip_reason: 'staff' }),
    ]);
    expect(l).toMatchObject({ label: 'order', pending: false });
  });

  it('tin khách mới nhất chưa phân loại xong → nhãn "cũ" (stale)', async () => {
    const l = await run([
      row(1, { intent: 'price_inquiry' }),
      row(2, { status: 'pending', intent: null }),
    ]);
    expect(l).toMatchObject({ label: 'price', stale: true });
  });

  it('chưa có tin khách nào được phân loại → không có nhãn', async () => {
    expect(
      await run([row(1, { status: 'pending', intent: null })]),
    ).toBeUndefined();
  });
});
