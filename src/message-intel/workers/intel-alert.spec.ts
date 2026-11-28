import {
  alertReason,
  alertSeverity,
  buildAlertCard,
  IntelAlertService,
} from './intel-alert.service';
import { utcTs } from '../sql-time';

const NOW = new Date('2026-11-27T10:00:00Z');
const job = (over: object = {}) => ({
  id: 1n,
  msgPid: 'm1',
  versionId: 2,
  messageId: 11n,
  pagePid: 'zlwA',
  tid: 'zlw900001',
  messageAt: new Date(NOW.getTime() - 10 * 60_000),
  intent: 'complaint',
  urgency: 2,
  isAnomaly: false,
  requiresEscalation: false,
  topics: ['missing_items'],
  sentiment: 'negative',
  burstMsgPids: [] as string[],
  ...over,
});

function make(
  opts: {
    jobs?: object[];
    rows?: object[];
    recent?: object | null;
    /** Kết quả reply (cảnh báo trong topic); mảng = lần lượt từng lần gọi */
    replyRes?: object | object[];
    /** Topic đang lưu: ngày + id tin mở đầu; bật / tắt + nhóm nhận (màn hình) */
    runtime?: {
      alertDay: string | null;
      alertRootMessageId: string | null;
      alertsEnabled?: boolean;
      alertChatId?: string | null;
    };
    /** Số dòng chèn được khi giành tin (0 = máy khác đã giành) */
    claimed?: number;
  } = {},
) {
  const jobs = opts.jobs ?? [job()];
  const prisma = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(jobs.map((j) => ({ id: (j as { id: bigint }).id }))),
    smaxMessageIntel: { findMany: jest.fn().mockResolvedValue(jobs) },
    smaxMessage: {
      findMany: jest.fn().mockResolvedValue(
        opts.rows ?? [
          {
            id: 11n,
            text: 'Hàng thiếu 2 gói, gọi chị 0912345678',
            attachments: null,
            sticker: null,
            recalled: false,
          },
        ],
      ),
    },
    smaxIntelAlert: {
      findFirst: jest.fn().mockResolvedValue(opts.recent ?? null),
      createMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    smaxThread: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Nhóm Chị Lan' }),
    },
    smaxSyncChannel: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Ms Mai Phương' }),
    },
    smaxIntelRuntime: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const intel = {
    activeVersion: jest.fn().mockResolvedValue({ id: 2 }),
    ourPagePids: jest.fn().mockResolvedValue(new Set(['zlwA'])),
    runtime: jest.fn().mockResolvedValue(
      opts.runtime ?? {
        alertDay: null,
        alertRootMessageId: null,
        alertsEnabled: true,
        alertChatId: null,
      },
    ),
  };
  // create = tin mở đầu topic của ngày
  const create = jest
    .fn()
    .mockResolvedValue({ code: 0, data: { message_id: 'om_root' } });
  const replies = Array.isArray(opts.replyRes)
    ? opts.replyRes
    : [opts.replyRes ?? { code: 0, data: { message_id: 'om_1' } }];
  const reply = jest.fn();
  for (const r of replies) reply.mockResolvedValueOnce(r);
  reply.mockResolvedValue(replies[replies.length - 1]);
  const lark = { im: { message: { create, reply } } };
  return {
    prisma,
    create,
    reply,
    svc: new IntelAlertService(prisma as any, intel as any, lark as any),
  };
}
/** Trạng thái cuối của dòng cảnh báo: dòng chèn (giành / gộp / thu hồi) + cập nhật sau khi gửi. */
const recorded = (prisma: ReturnType<typeof make>['prisma']) => ({
  ...(
    (prisma.smaxIntelAlert.createMany.mock.calls as unknown[][])[0][0] as {
      data: Record<string, unknown>[];
    }
  ).data[0],
  ...(
    (prisma.smaxIntelAlert.updateMany.mock.calls as unknown[][])[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined
  )?.data,
});

afterEach(() => {
  delete process.env.MESSAGE_INTEL_ENABLED;
});

describe('alertReason', () => {
  it('cần quản lý; khiếu nại độ khẩn ≥ 2; bất thường độ khẩn 3; còn lại không báo', () => {
    expect(
      alertReason(
        job({ requiresEscalation: true, intent: 'order', urgency: 0 }) as any,
      ),
    ).toBe('escalation');
    expect(alertReason(job() as any)).toBe('complaint');
    expect(alertReason(job({ urgency: 1 }) as any)).toBeNull();
    expect(
      alertReason(job({ intent: 'order', isAnomaly: true, urgency: 3 }) as any),
    ).toBe('anomaly');
    expect(
      alertReason(job({ intent: 'order', isAnomaly: true, urgency: 2 }) as any),
    ).toBeNull();
  });
});

describe('IntelAlertService', () => {
  it('tắt trên màn hình (alerts_enabled = false, mặc định) → không xét, không gửi; bật → xét', async () => {
    process.env.MESSAGE_INTEL_ENABLED = 'true';
    const off = make({
      runtime: {
        alertDay: null,
        alertRootMessageId: null,
        alertsEnabled: false,
        alertChatId: null,
      },
    });
    await off.svc.tick();
    expect(off.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(off.create).not.toHaveBeenCalled();
    const on = make();
    await on.svc.tick();
    expect(on.prisma.$queryRaw).toHaveBeenCalled();
  });

  it('chat id đặt trên màn hình → gửi vào nhóm đó', async () => {
    const { create, svc } = make({
      runtime: {
        alertDay: null,
        alertRootMessageId: null,
        alertsEnabled: true,
        alertChatId: 'oc_customgroup123456',
      },
    });
    await svc.runOnce(NOW);
    expect(
      (create.mock.calls[0] as [{ data: { receive_id: string } }])[0].data
        .receive_id,
    ).toBe('oc_customgroup123456');
  });

  it('máy khác đã giành tin (chèn dòng không được) → không gửi', async () => {
    const { reply, create, svc } = make({ claimed: 0 });
    expect(await svc.runOnce(NOW)).toEqual({ sent: 0 });
    expect(reply).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('máy khác vừa đặt topic hôm nay trước → dùng topic của máy đó', async () => {
    const { prisma, reply, svc } = make();
    prisma.smaxIntelRuntime.updateMany.mockResolvedValue({ count: 0 });
    const intelRuntime = (svc as unknown as { intel: { runtime: jest.Mock } })
      .intel.runtime;
    intelRuntime
      .mockResolvedValueOnce({
        alertDay: null,
        alertRootMessageId: null,
        alertsEnabled: true,
        alertChatId: null,
      })
      .mockResolvedValueOnce({
        alertDay: '2026-11-27',
        alertRootMessageId: 'om_other',
        alertsEnabled: true,
        alertChatId: null,
      });
    await svc.runOnce(NOW);
    expect(
      (reply.mock.calls[0] as [{ path: { message_id: string } }])[0].path
        .message_id,
    ).toBe('om_other');
  });

  it('cảnh báo đầu tiên trong ngày: tạo tin mở đầu topic trong nhóm, cảnh báo trả lời trong topic (đã che SĐT)', async () => {
    const { prisma, create, reply, svc } = make();
    expect(await svc.runOnce(NOW)).toEqual({ sent: 1 });
    const root = (
      create.mock.calls[0] as [
        { data: { receive_id: string; content: string } },
      ]
    )[0].data;
    expect(root.receive_id).toBe('oc_92ea2a2bbcca2116111809a3461f5795');
    expect(root.content).toContain('CẢNH BÁO CHAT KHÁCH · 27/11/2026');
    expect(
      (prisma.smaxIntelRuntime.updateMany.mock.calls as unknown[][])[0][0],
    ).toMatchObject({
      where: { id: 1 },
      data: { alertDay: '2026-11-27', alertRootMessageId: 'om_root' },
    });
    expect(
      (create.mock.calls[0] as [{ data: { uuid: string } }])[0].data.uuid,
    ).toMatch(/^intel-root-2026-11-27-/);
    const sent = (
      reply.mock.calls[0] as [
        {
          path: { message_id: string };
          data: { content: string; reply_in_thread: boolean; uuid: string };
        },
      ]
    )[0];
    expect(sent.path.message_id).toBe('om_root');
    expect(sent.data.reply_in_thread).toBe(true);
    expect(sent.data.uuid).toBe('intel-m1');
    expect(sent.data.content).toContain('[SĐT]');
    expect(sent.data.content).not.toContain('0912345678');
    expect(recorded(prisma)).toMatchObject({
      status: 'sent',
      reason: 'complaint',
      larkMessageId: 'om_1',
    });
  });

  it('đã có topic hôm nay → trả lời vào đó, không tạo topic mới; topic hôm qua → tạo topic mới', async () => {
    const today = make({
      runtime: { alertDay: '2026-11-27', alertRootMessageId: 'om_today' },
    });
    await today.svc.runOnce(NOW);
    expect(today.create).not.toHaveBeenCalled();
    expect(
      (today.reply.mock.calls[0] as [{ path: { message_id: string } }])[0].path
        .message_id,
    ).toBe('om_today');
    const yesterday = make({
      runtime: { alertDay: '2026-11-26', alertRootMessageId: 'om_old' },
    });
    await yesterday.svc.runOnce(NOW);
    expect(yesterday.create).toHaveBeenCalledTimes(1);
  });

  it('topic hỏng (tin mở đầu bị xoá) → tạo topic mới và gửi lại 1 lần', async () => {
    const { create, reply, prisma, svc } = make({
      runtime: { alertDay: '2026-11-27', alertRootMessageId: 'om_deleted' },
      replyRes: [
        { code: 230011, msg: 'message deleted' },
        { code: 0, data: { message_id: 'om_2' } },
      ],
    });
    expect(await svc.runOnce(NOW)).toEqual({ sent: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      (reply.mock.calls[1] as [{ path: { message_id: string } }])[0].path
        .message_id,
    ).toBe('om_root');
    expect(recorded(prisma)).toMatchObject({
      status: 'sent',
      larkMessageId: 'om_2',
    });
  });

  it('đã báo hội thoại này trong 4 giờ → gộp, không gửi', async () => {
    const { prisma, create, svc } = make({ recent: { id: 9 } });
    await svc.runOnce(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(recorded(prisma)).toMatchObject({ status: 'grouped' });
  });

  it('tin đã thu hồi → không báo', async () => {
    const { prisma, create, svc } = make({
      rows: [{ id: 11n, text: 'x', recalled: true }],
    });
    await svc.runOnce(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(recorded(prisma)).toMatchObject({ status: 'recalled' });
  });

  it('Lark lỗi → ghi failed (không gửi lại tự động)', async () => {
    const { prisma, svc } = make({
      replyRes: { code: 230002, msg: 'bot not in chat' },
    });
    expect(await svc.runOnce(NOW)).toEqual({ sent: 0 });
    expect(recorded(prisma)).toMatchObject({ status: 'failed' });
  });

  it('chỉ xét tin mới (≤ 2 giờ) chưa xét: điều kiện nằm trong truy vấn', async () => {
    const { prisma, svc } = make({ jobs: [] });
    await svc.runOnce(NOW);
    const sql = (
      (prisma.$queryRaw.mock.calls as unknown[][])[0][0] as string[]
    ).join('?');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM smax_intel_alerts');
    // Mốc so với cột TIMESTAMP giờ UTC: đổi về UTC, không phụ thuộc múi giờ phiên DB (production +07)
    expect((prisma.$queryRaw.mock.calls[0] as unknown[])[2]).toEqual(
      utcTs(new Date(NOW.getTime() - 2 * 3_600_000)),
    );
    expect(utcTs(NOW).text).toBe(`($1::timestamptz AT TIME ZONE 'UTC')`);
  });
});

describe('alertSeverity', () => {
  it('độ khẩn 3 → Khẩn cấp; 2 hoặc cần quản lý → Ưu tiên; bất thường → Theo dõi; còn lại → Thông tin', () => {
    expect(alertSeverity('complaint', 3)).toBe('urgent');
    expect(alertSeverity('complaint', 2)).toBe('priority');
    expect(alertSeverity('escalation', 0)).toBe('priority');
    expect(alertSeverity('anomaly', 1)).toBe('watch');
    expect(alertSeverity('complaint', 1)).toBe('info');
  });
});

describe('buildAlertCard', () => {
  type Card = ReturnType<typeof buildAlertCard>;
  const card = (
    over: object = {},
    reason: Parameters<typeof buildAlertCard>[0]['reason'] = 'complaint',
  ): Card =>
    buildAlertCard({
      reason,
      job: job({
        messageAt: new Date('2026-11-27T07:26:00Z'),
        topics: ['order', 'delivery', 'missing_items'],
        ...over,
      }) as unknown as Parameters<typeof buildAlertCard>[0]['job'],
      text: 'Đơn của a chưa thấy có',
      thread: 'Mr Minh Hoàn Kiếm HN – Diệp Trà',
      channel: 'Diệp Trà – Ms Mai Phương',
      smaxUrl: 'https://smax.ai/x',
    });

  it('header chỉ loại cảnh báo + mức độ (không có tên khách); màu theo mức độ', () => {
    const c = card();
    expect(c.header.title.content).toBe('⚠️ CẢNH BÁO KHIẾU NẠI');
    expect(c.header.subtitle.content).toBe('Mức độ: Ưu tiên');
    expect(c.header.template).toBe('orange');
    expect(JSON.stringify(c.header)).not.toContain('Minh Hoàn Kiếm');
    expect(card({ urgency: 3 }).header).toMatchObject({
      template: 'red',
      subtitle: { content: 'Mức độ: Khẩn cấp' },
    });
    expect(
      card({ intent: 'other', isAnomaly: true, urgency: 1 }, 'anomaly').header,
    ).toMatchObject({
      template: 'yellow',
      title: { content: '⚠️ CẢNH BÁO BẤT THƯỜNG' },
    });
  });

  it('thân card: khách / kênh / giờ VN, tin trong khung nền, Phân loại + Chủ đề tách dòng, nút toàn chiều rộng, lưu ý AI cuối', () => {
    const json = JSON.stringify(card().body);
    expect(json).toContain('**Mr Minh Hoàn Kiếm HN – Diệp Trà**');
    expect(json).toContain('Kênh: Diệp Trà – Ms Mai Phương');
    expect(json).toContain('14:26 · 27/11/2026');
    expect(json).toContain('"background_style":"grey"');
    expect(json).toContain('“Đơn của a chưa thấy có”');
    expect(json).toContain('Phân loại');
    expect(json).toContain('**Khiếu nại**');
    expect(json).toContain('Đơn hàng, Giao hàng, Thiếu hàng');
    const els = card().body.elements as {
      tag: string;
      width?: string;
      content?: string;
    }[];
    expect(els.find((e) => e.tag === 'button')).toMatchObject({
      width: 'fill',
    });
    expect(els[els.length - 1].content).toContain(
      'Kết quả phân loại từ AI, cần kiểm tra lại hội thoại.',
    );
  });
});
