import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { SmaxMessage, SmaxMessageIntel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LARK_CLIENT } from '../../lark-sync/lark-client.provider';
import { MessageIntelService } from '../message-intel.service';
import { utcTs } from '../sql-time';
import { alertSettings, intelConfig, vnDay } from '../message-intel.config';
import { contentOf, loadBurstTexts } from '../context/context-builder';
import { INTENTS, TOPICS } from '../taxonomy/taxonomy-v1';

/** Chỉ cảnh báo tin mới (không cảnh báo tin cũ do backfill phân loại lại). */
const FRESH_MS = 2 * 3_600_000;
/** Đã cảnh báo hội thoại này trong khoảng này → gộp, không gửi thêm. */
const GROUP_MS = 4 * 3_600_000;
const BATCH = 20;
export type AlertReason = 'escalation' | 'complaint' | 'anomaly';
/** Mức độ cảnh báo → màu header (quy chuẩn màu: đỏ / cam / vàng / xanh). */
export type AlertSeverity = 'urgent' | 'priority' | 'watch' | 'info';
const SEVERITY: Record<AlertSeverity, { label: string; template: string }> = {
  urgent: { label: 'Khẩn cấp', template: 'red' },
  priority: { label: 'Ưu tiên', template: 'orange' },
  watch: { label: 'Theo dõi', template: 'yellow' },
  info: { label: 'Thông tin', template: 'blue' },
};

/**
 * Mức độ theo độ khẩn AI chấm (không dồn mọi khiếu nại vào "khẩn cấp" để tránh chai cảnh báo): độ khẩn 3 →
 * Khẩn cấp; độ khẩn 2 hoặc cần quản lý → Ưu tiên; bất thường → Theo dõi; còn lại → Thông tin.
 */
export function alertSeverity(
  reason: AlertReason,
  urgency: number | null,
): AlertSeverity {
  if ((urgency ?? 0) >= 3) return 'urgent';
  if ((urgency ?? 0) === 2 || reason === 'escalation') return 'priority';
  if (reason === 'anomaly') return 'watch';
  return 'info';
}

/** Tin cần báo quản lý: cần quản lý; khiếu nại độ khẩn ≥ 2; bất thường độ khẩn 3. */
export function alertReason(
  j: Pick<
    SmaxMessageIntel,
    'requiresEscalation' | 'intent' | 'urgency' | 'isAnomaly'
  >,
): AlertReason | null {
  if (j.requiresEscalation) return 'escalation';
  if (j.intent === 'complaint' && (j.urgency ?? 0) >= 2) return 'complaint';
  if (j.isAnomaly && (j.urgency ?? 0) >= 3) return 'anomaly';
  return null;
}

/** Tin mở đầu topic cảnh báo của ngày (cảnh báo trong ngày trả lời trong topic này). */
export function buildDayRootCard(day: string) {
  const [y, m, d] = day.split('-');
  return {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: `⚠️ CẢNH BÁO CHAT KHÁCH · ${d}/${m}/${y}`,
      },
      subtitle: {
        tag: 'plain_text',
        content: 'AI phân loại tin nhắn · tự động',
      },
      template: 'red',
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 12px 16px',
      elements: [
        {
          tag: 'markdown',
          content: [
            'Các tin khách cần quản lý chú ý trong ngày được gửi **trong chủ đề này**: khiếu nại, sự cố bất thường, tin cần quản lý xử lý.',
            '<font color="grey">Nhãn do AI gắn, có thể sai — mở hội thoại để kiểm tra trước khi xử lý.</font>',
          ].join('\n'),
        },
      ],
    },
  };
}

/** Loại cảnh báo trên header: theo ý định trước (khiếu nại), rồi cờ. */
const alertKind = (reason: AlertReason, intent: string | null) =>
  intent === 'complaint'
    ? 'KHIẾU NẠI'
    : reason === 'anomaly'
      ? 'BẤT THƯỜNG'
      : 'CẦN QUẢN LÝ';

/** Một dòng "nhãn — giá trị" (nhãn xám bên trái, giá trị bên phải). */
const field = (label: string, value: string, bold = false) => ({
  tag: 'column_set',
  horizontal_spacing: '8px',
  columns: [
    {
      tag: 'column',
      width: 'auto',
      elements: [
        { tag: 'markdown', content: `<font color="grey">${label}</font>` },
      ],
    },
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'markdown',
          text_align: 'right',
          content: bold ? `**${value}**` : value,
        },
      ],
    },
  ],
});

/**
 * Card Lark 2.0 cho 1 tin cần chú ý: header chỉ loại cảnh báo + mức độ (màu theo mức độ), khách / kênh / giờ,
 * nội dung tin trong khung nền riêng (đã che SĐT / email / link), kết quả AI tách từng dòng, nút mở hội thoại
 * toàn chiều rộng, lưu ý AI chữ nhỏ cuối card.
 */
export function buildAlertCard(input: {
  reason: AlertReason;
  job: Pick<
    SmaxMessageIntel,
    'intent' | 'urgency' | 'topics' | 'sentiment' | 'messageAt'
  >;
  text: string;
  thread: string;
  channel: string;
  smaxUrl: string;
}) {
  const severity = SEVERITY[alertSeverity(input.reason, input.job.urgency)];
  const vn = new Date(
    input.job.messageAt.getTime() + 7 * 3_600_000,
  ).toISOString();
  const when = `${vn.slice(11, 16)} · ${vn.slice(8, 10)}/${vn.slice(5, 7)}/${vn.slice(0, 4)}`;
  const intent =
    INTENTS[input.job.intent as keyof typeof INTENTS]?.[0] ?? 'Khác';
  const topics = input.job.topics
    .map((t) => TOPICS[t as keyof typeof TOPICS]?.[0] ?? t)
    .join(', ');
  const hr = { tag: 'hr' };
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `⚠️ CẢNH BÁO ${alertKind(input.reason, input.job.intent)}`,
      },
      subtitle: { tag: 'plain_text', content: `Mức độ: ${severity.label}` },
      template: severity.template,
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 12px 16px',
      vertical_spacing: '10px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `👤 **${input.thread}**`,
            `<font color="grey">Kênh: ${input.channel}</font>`,
            `<font color="grey">${when}</font>`,
          ].join('\n'),
        },
        hr,
        { tag: 'markdown', content: '**Nội dung khách hàng**' },
        {
          tag: 'column_set',
          background_style: 'grey',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '10px 12px 10px 12px',
              elements: [
                {
                  tag: 'markdown',
                  content: `“${input.text || '(không có chữ)'}”`,
                },
              ],
            },
          ],
        },
        { tag: 'markdown', content: '**Kết quả phân tích AI**' },
        field('Phân loại', intent, true),
        ...(topics ? [field('Chủ đề', topics)] : []),
        hr,
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Mở hội thoại trên Smax' },
          type: 'primary',
          width: 'fill',
          behaviors: [{ type: 'open_url', default_url: input.smaxUrl }],
        },
        {
          tag: 'markdown',
          text_align: 'center',
          text_size: 'notation',
          content:
            '<font color="grey">Kết quả phân loại từ AI, cần kiểm tra lại hội thoại.</font>',
        },
      ],
    },
  };
}

/**
 * Cảnh báo quản lý: mỗi phút xét tin vừa phân loại (≤ 2 giờ tuổi) theo `alertReason`, bỏ tin đã thu hồi,
 * gộp theo hội thoại (đã báo trong 4 giờ thì chỉ ghi nhận), gửi card vào nhóm Lark — mỗi ngày 1 topic: cảnh báo
 * đầu tiên trong ngày tạo tin mở đầu, các cảnh báo trả lời trong topic đó. Mỗi tin xét 1 lần
 * (smax_intel_alerts). Bật / tắt và nhóm nhận đặt trên màn hình (mặc định tắt; bản sao DB cho dev tự tắt).
 */
@Injectable()
export class IntelAlertService {
  private readonly logger = new Logger(IntelAlertService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly intel: MessageIntelService,
    @Inject(LARK_CLIENT) private readonly lark: lark.Client,
  ) {}

  @Interval(60_000)
  async tick() {
    if (!intelConfig().enabled || this.running) return;
    this.running = true;
    try {
      // Bật / tắt trên màn hình Phân tích tin nhắn (smax_intel_runtime.alerts_enabled)
      if ((await this.intel.runtime()).alertsEnabled) await this.runOnce();
    } catch (error) {
      this.logger.error(`Cảnh báo phân loại tin lỗi: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(now = new Date()) {
    const version = await this.intel.activeVersion();
    if (!version) return { sent: 0 };
    const ids = await this.prisma.$queryRaw<{ id: bigint }[]>`
      SELECT i.id FROM smax_message_intel i
      WHERE i.version_id = ${version.id} AND i.status = 'completed'
        AND i.message_at >= ${utcTs(new Date(now.getTime() - FRESH_MS))}
        AND (i.requires_escalation OR (i.intent = 'complaint' AND i.urgency >= 2) OR (i.is_anomaly AND i.urgency >= 3))
        AND NOT EXISTS (SELECT 1 FROM smax_intel_alerts a WHERE a.msg_pid = i.msg_pid AND a.version_id = i.version_id)
      ORDER BY i.message_at ASC LIMIT ${BATCH}`;
    if (!ids.length) return { sent: 0 };
    const candidates = await this.prisma.smaxMessageIntel.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { messageAt: 'asc' },
    });
    let sent = 0;
    const ours = [...(await this.intel.ourPagePids())];
    for (const job of candidates) {
      const reason = alertReason(job);
      if (!reason) continue;
      const base = {
        msgPid: job.msgPid,
        versionId: version.id,
        pagePid: job.pagePid,
        tid: job.tid,
        reason,
        messageAt: job.messageAt,
      };
      const rows = await this.prisma.smaxMessage.findMany({
        where: { pagePid: { in: ours }, msgPid: job.msgPid },
      });
      if (rows.some((r) => r.recalled)) {
        await this.record({ ...base, status: 'recalled' });
        continue;
      }
      const recent = await this.prisma.smaxIntelAlert.findFirst({
        where: {
          pagePid: job.pagePid,
          tid: job.tid,
          status: 'sent',
          createdAt: { gte: new Date(now.getTime() - GROUP_MS) },
        },
      });
      if (recent) {
        await this.record({ ...base, status: 'grouped' });
        continue;
      }
      const rep: SmaxMessage | undefined =
        rows.find((r) => r.id === job.messageId) ?? rows[0];
      const [thread, channel] = await Promise.all([
        this.prisma.smaxThread.findUnique({
          where: { pagePid_tid: { pagePid: job.pagePid, tid: job.tid } },
          select: { name: true },
        }),
        this.prisma.smaxSyncChannel.findUnique({
          where: { pagePid: job.pagePid },
          select: { name: true },
        }),
      ]);
      // Tin cuối cụm: hiện cả cụm tin khách gửi liên tiếp
      const burstText = (await loadBurstTexts(this.prisma, [job])).get(
        job.msgPid,
      );
      const card = buildAlertCard({
        reason,
        job,
        text: (burstText ?? (rep ? contentOf(rep) : '')).slice(0, 300),
        thread: thread?.name || 'Hội thoại',
        channel: channel?.name ?? job.pagePid,
        smaxUrl: `https://smax.ai/bizs/${process.env.SMAX_BIZ_ALIAS?.trim() || 'dieptra'}/chats/${job.pagePid}?tid=${job.tid}`,
      });
      // Giành tin trước khi gửi: nhiều backend cùng chạy thì chỉ máy chèn được dòng 'sending' mới gửi
      if (!(await this.record({ ...base, status: 'sending' }))) continue;
      try {
        const res = await this.replyInDayTopic(job.msgPid, card, now);
        await this.finish(base, {
          status: 'sent',
          larkMessageId: res?.data?.message_id ?? null,
        });
        sent++;
      } catch (error) {
        await this.finish(base, {
          status: 'failed',
          error: String(error).slice(0, 500),
        });
        this.logger.warn(
          `Không gửi được cảnh báo ${job.msgPid}: ${String(error)}`,
        );
      }
    }
    return { sent };
  }

  /** Gửi cảnh báo trả lời trong topic của ngày; topic hỏng (vd tin mở đầu bị xoá) → tạo topic mới, thử lại 1 lần. */
  private async replyInDayTopic(msgPid: string, card: object, now: Date) {
    const send = async (rootId: string) => {
      const res = await this.lark.im.message.reply({
        path: { message_id: rootId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: true,
          // Lark bỏ trùng theo uuid: worker chết giữa chừng gửi lại không ra 2 tin
          uuid: `intel-${msgPid}`.slice(0, 50),
        },
      });
      if (res?.code && res.code !== 0)
        throw new Error(`Lark lỗi ${res.code}: ${res.msg}`);
      return res;
    };
    const root = await this.dayRoot(now);
    try {
      return await send(root);
    } catch (error) {
      this.logger.warn(
        `Topic cảnh báo ${root} không dùng được (${String(error)}) → tạo topic mới`,
      );
      return send(await this.dayRoot(now, true));
    }
  }

  /** Tin mở đầu topic cảnh báo của ngày (giờ VN): có rồi thì dùng lại, chưa có / `renew` thì gửi mới. */
  private async dayRoot(now: Date, renew = false) {
    const day = vnDay(now);
    const runtime = await this.intel.runtime();
    if (!renew && runtime.alertDay === day && runtime.alertRootMessageId)
      return runtime.alertRootMessageId;
    const { chatId } = alertSettings(runtime);
    const res = await this.lark.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(buildDayRootCard(day)),
        // Lark bỏ trùng theo uuid: nhiều backend cùng tạo topic trong ngày chỉ ra 1 tin
        uuid: `intel-root-${day}-${chatId.slice(-8)}${renew ? `-${now.getTime()}` : ''}`,
      },
    });
    const id = res?.data?.message_id;
    if ((res?.code && res.code !== 0) || !id)
      throw new Error(`Lark lỗi tạo topic ${res?.code}: ${res?.msg}`);
    if (renew) {
      await this.prisma.smaxIntelRuntime.update({
        where: { id: 1 },
        data: { alertDay: day, alertRootMessageId: id },
      });
      return id;
    }
    // Chỉ đặt khi chưa có topic hôm nay; máy khác vừa đặt trước → dùng topic của máy đó
    const { count } = await this.prisma.smaxIntelRuntime.updateMany({
      where: {
        id: 1,
        OR: [
          { alertDay: null },
          { alertDay: { not: day } },
          { alertRootMessageId: null },
        ],
      },
      data: { alertDay: day, alertRootMessageId: id },
    });
    if (count) return id;
    return (await this.intel.runtime()).alertRootMessageId ?? id;
  }

  /** Ghi dòng xét cảnh báo; trả true khi chèn được (false = tin đã có dòng, máy khác đã xét). */
  private async record(data: {
    msgPid: string;
    versionId: number;
    pagePid: string;
    tid: string;
    reason: AlertReason;
    messageAt: Date;
    status: string;
  }) {
    const { count } = await this.prisma.smaxIntelAlert.createMany({
      data: [data],
      skipDuplicates: true,
    });
    return count === 1;
  }

  private finish(
    key: { msgPid: string; versionId: number },
    data: { status: string; larkMessageId?: string | null; error?: string },
  ) {
    return this.prisma.smaxIntelAlert.updateMany({
      where: {
        msgPid: key.msgPid,
        versionId: key.versionId,
        status: 'sending',
      },
      data,
    });
  }
}
