import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { mask } from '../../ai-assistant/tools/smax-chats.tool';
import { BUSINESS_CONTEXT } from '../taxonomy/taxonomy-v1';
import {
  type ArchiveRow,
  isStaffMessage,
  isSystemNotice,
  ORDER_REPORT,
} from '../rules/rule-engine';
import { BURST_MAX_SPAN_MS, BURST_SETTLE_MS, findBurst } from '../rules/burst';

/** Số tin liền trước đưa vào ngữ cảnh. */
export const PREVIOUS_LIMIT = 5;
const MAX_TEXT = 500;
/** Tin đích sát mốc bắt đầu lưu của kênh (trong khoảng này) → có thể thiếu tin trước đó. */
const PARTIAL_WINDOW_MS = 24 * 3_600_000;
/** Nội dung cụm gửi AI (các tin nối bằng xuống dòng) */
const MAX_BURST_TEXT = 2_000;
/** Tìm đầu cụm trong khoảng này trước tin đích (chuỗi tin liên tiếp dài hơn rất hiếm) */
const BURST_LOOKBACK_MS = 60 * 60_000;

export type Role = 'customer' | 'staff' | 'other_member';
export type ContextLine = { role: Role; text: string };

/** state gửi Jev: không tên người, không SĐT / email / link / số tài khoản, không link tệp. */
export type JevState = {
  business: string;
  conversation_type: 'group' | 'private';
  target: ContextLine;
  quoted: ContextLine | null;
  previous: ContextLine[];
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
// Chuỗi số dài còn lại sau khi che SĐT: số tài khoản, CCCD, mã giao dịch (giữ số lượng / giá thông thường)
const LONG_NUMBER = /\b\d(?:[\s.-]?\d){8,}\b/g;
// "@Tên người được tag" trong nhóm Zalo
const MENTION = /@[\p{Lu}(][^\s@]*(?:\s+[\p{Lu}(][^\s@]*)*/gu;

/** Che thông tin định danh trong nội dung tin trước khi gửi ra ngoài. */
export function redact(text: string) {
  return mask(text)
    .replace(EMAIL, '[email]')
    .replace(URL, '[link]')
    .replace(LONG_NUMBER, '[số]')
    .replace(MENTION, '@[người]')
    .slice(0, MAX_TEXT);
}

type Attachment = { type?: string };

/** Nội dung 1 tin: chữ đã che + đánh dấu ảnh / video / tệp (không gửi link). */
export function contentOf(
  row: Pick<ArchiveRow, 'text' | 'attachments' | 'sticker'>,
) {
  const parts: string[] = [];
  if (row.text.trim()) parts.push(redact(row.text.trim()));
  const attachments = Array.isArray(row.attachments)
    ? (row.attachments as Attachment[])
    : [];
  for (const a of attachments)
    parts.push(
      a.type === 'image' || a.type === 'photo'
        ? '[ảnh]'
        : a.type === 'video'
          ? '[video]'
          : '[tệp]',
    );
  if (!parts.length && row.sticker) parts.push('[sticker]');
  return parts.join(' ');
}

/** Vai người gửi: phía công ty → staff; chat riêng → customer; nhóm → other_member (không mặc định là khách). */
export function roleOf(staff: boolean, isGroup: boolean): Role {
  if (staff) return 'staff';
  return isGroup ? 'other_member' : 'customer';
}

export type StateInput = {
  target: ArchiveRow;
  /** Cụm tin (≥ 2 tin, tin đích là tin cuối): gửi cả cụm, ngữ cảnh lấy trước tin đầu cụm */
  burst?: ArchiveRow[];
  isGroup: boolean;
  /** Tin liền trước, mới nhất trước hoặc sau đều được (sẽ sắp lại theo thời gian) */
  previous: { row: ArchiveRow; staff: boolean }[];
  quoted: { text: string; staff: boolean } | null;
};

/** Dựng state Jev từ dữ liệu đã tải (hàm thuần). Tin trước sắp theo created_at, id tăng dần. */
export function buildState(input: StateInput): JevState {
  const burst = input.burst && input.burst.length > 1 ? input.burst : null;
  const anchor = burst?.[0] ?? input.target;
  const previous = [...input.previous]
    .filter(
      (p) =>
        p.row.createdAt < anchor.createdAt ||
        (p.row.createdAt.getTime() === anchor.createdAt.getTime() &&
          p.row.id < anchor.id),
    )
    .sort(
      (a, b) =>
        a.row.createdAt.getTime() - b.row.createdAt.getTime() ||
        (a.row.id < b.row.id ? -1 : 1),
    )
    .slice(-PREVIOUS_LIMIT)
    .map((p) => ({
      role: roleOf(p.staff, input.isGroup),
      text: contentOf(p.row),
    }))
    .filter((p) => p.text);
  return {
    business: BUSINESS_CONTEXT,
    conversation_type: input.isGroup ? 'group' : 'private',
    target: {
      role: roleOf(false, input.isGroup),
      text: burst
        ? burst
            .map(contentOf)
            .filter(Boolean)
            .join('\n')
            .slice(0, MAX_BURST_TEXT)
        : contentOf(input.target),
    },
    quoted: input.quoted?.text.trim()
      ? {
          role: roleOf(input.quoted.staff, input.isGroup),
          text: redact(input.quoted.text.trim()),
        }
      : null,
    previous,
  };
}

/**
 * Nội dung các cụm tin (tin cuối cụm có burstMsgPids): msg_pid tin cuối cụm → các tin trong cụm (đã che,
 * ảnh thành [ảnh]) theo thời gian, nối bằng xuống dòng. Đọc dòng của các tin ở kênh `pagePid`.
 */
export async function loadBurstTexts(
  prisma: PrismaService,
  items: { pagePid: string; msgPid: string; burstMsgPids: string[] }[],
) {
  const bursts = items.filter((i) => i.burstMsgPids.length > 1);
  const out = new Map<string, string>();
  if (!bursts.length) return out;
  const rows = await prisma.smaxMessage.findMany({
    where: {
      OR: bursts.map((b) => ({
        pagePid: b.pagePid,
        msgPid: { in: b.burstMsgPids },
      })),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const b of bursts) {
    const members = new Set(b.burstMsgPids);
    out.set(
      b.msgPid,
      rows
        .filter((r) => r.pagePid === b.pagePid && members.has(r.msgPid))
        .map(contentOf)
        .filter(Boolean)
        .join('\n'),
    );
  }
  return out;
}

type QuoteJson = {
  pid?: string | null;
  text?: string;
  senderName?: string | null;
};

/** Tải ngữ cảnh của tin đích từ kho tin (cùng page_pid / tid với dòng đại diện) rồi dựng state. */
@Injectable()
export class ContextBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async build(
    target: ArchiveRow & { quote?: unknown },
    ourPagePids: ReadonlySet<string>,
    burstRows?: (ArchiveRow & { quote?: unknown })[],
  ) {
    const burst = burstRows && burstRows.length > 1 ? burstRows : undefined;
    // Cụm: ngữ cảnh là các tin trước tin đầu cụm
    const anchor = burst?.[0] ?? target;
    const at = anchor.createdAt;
    const [thread, previousRows, channel] = await Promise.all([
      this.prisma.smaxThread.findUnique({
        where: { pagePid_tid: { pagePid: target.pagePid, tid: target.tid } },
        select: { isGroup: true },
      }),
      // Chỉ tin trước tin đích: (created_at, id) < (at, id) — không lấy tin tương lai
      this.prisma.smaxMessage.findMany({
        where: {
          pagePid: target.pagePid,
          tid: target.tid,
          type: 'message',
          recalled: false,
          OR: [
            { createdAt: { lt: at } },
            { createdAt: at, id: { lt: anchor.id } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PREVIOUS_LIMIT,
      }),
      this.prisma.smaxSyncChannel.findUnique({
        where: { pagePid: target.pagePid },
        select: { backfillFrom: true },
      }),
    ]);
    // Tin trước do kênh khác của công ty gửi: dòng cùng msg_pid ở kênh đó có from_me
    const quote = ((burst ?? [target]).find((r) => r.quote)?.quote ??
      null) as QuoteJson | null;
    const pids = [
      ...previousRows.map((r) => r.msgPid),
      ...(quote?.pid ? [quote.pid] : []),
    ];
    const sentByUs = pids.length
      ? new Set(
          (
            await this.prisma.smaxMessage.findMany({
              // Kèm page_pid để dùng index unique (page_pid, msg_pid); kênh gửi luôn là kênh của công ty
              where: {
                pagePid: { in: [...ourPagePids] },
                msgPid: { in: pids },
                fromMe: true,
              },
              select: { msgPid: true },
            })
          ).map((r) => r.msgPid),
        )
      : new Set<string>();
    const staff = (
      row: Pick<ArchiveRow, 'msgPid' | 'fromMe' | 'senderPid' | 'senderName'>,
    ) =>
      sentByUs.has(row.msgPid) ||
      isStaffMessage([row as ArchiveRow], ourPagePids);
    const isGroup = thread?.isGroup ?? false;
    const state = buildState({
      target,
      burst,
      isGroup,
      previous: previousRows.map((row) => ({ row, staff: staff(row) })),
      quoted: quote?.text
        ? {
            text: quote.text,
            staff:
              (!!quote.pid && sentByUs.has(quote.pid)) ||
              isStaffMessage(
                [
                  {
                    fromMe: false,
                    senderPid: null,
                    senderName: quote.senderName ?? null,
                  } as ArchiveRow,
                ],
                ourPagePids,
              ),
          }
        : null,
    });
    // Chưa đủ tin trước mà kênh mới bắt đầu lưu sát trước tin đích → kho có thể thiếu tin cũ hơn
    const contextPartial =
      previousRows.length < PREVIOUS_LIMIT &&
      (!channel ||
        at.getTime() - channel.backfillFrom.getTime() < PARTIAL_WINDOW_MS);
    return { state, isGroup, contextPartial };
  }

  /**
   * Cụm tin chứa tin đích trong hội thoại của dòng đại diện: tin khách liên tiếp cùng người gửi (xem
   * rules/burst). Tin nhân viên gửi từ kênh khác (from_me ở dòng của kênh đó) cắt cụm như tin nhân viên.
   */
  async burst(
    target: ArchiveRow,
    ourPagePids: ReadonlySet<string>,
    now = new Date(),
  ) {
    const t = target.createdAt.getTime();
    const rows = await this.prisma.smaxMessage.findMany({
      where: {
        pagePid: target.pagePid,
        tid: target.tid,
        type: 'message',
        recalled: false,
        createdAt: {
          gte: new Date(t - BURST_LOOKBACK_MS),
          lte: new Date(t + BURST_MAX_SPAN_MS + BURST_SETTLE_MS),
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const sentByUs = rows.length
      ? new Set(
          (
            await this.prisma.smaxMessage.findMany({
              where: {
                pagePid: { in: [...ourPagePids] },
                msgPid: { in: rows.map((r) => r.msgPid) },
                fromMe: true,
              },
              select: { msgPid: true },
            })
          ).map((r) => r.msgPid),
        )
      : new Set<string>();
    const found = findBurst(
      rows.map((r) => ({
        ...r,
        member:
          !sentByUs.has(r.msgPid) &&
          !isStaffMessage([r], ourPagePids) &&
          !isSystemNotice(r.text) &&
          !ORDER_REPORT.test(r.text),
      })),
      target.msgPid,
      now,
    );
    return found ?? { members: [target], complete: true };
  }
}
