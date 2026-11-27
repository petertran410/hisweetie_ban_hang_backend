import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { mask } from '../../ai-assistant/tools/smax-chats.tool';
import { BUSINESS_CONTEXT } from '../taxonomy/taxonomy-v1';
import { type ArchiveRow, isStaffMessage } from '../rules/rule-engine';

/** Số tin liền trước đưa vào ngữ cảnh. */
export const PREVIOUS_LIMIT = 5;
const MAX_TEXT = 500;
/** Tin đích sát mốc bắt đầu lưu của kênh (trong khoảng này) → có thể thiếu tin trước đó. */
const PARTIAL_WINDOW_MS = 24 * 3_600_000;

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
  isGroup: boolean;
  /** Tin liền trước, mới nhất trước hoặc sau đều được (sẽ sắp lại theo thời gian) */
  previous: { row: ArchiveRow; staff: boolean }[];
  quoted: { text: string; staff: boolean } | null;
};

/** Dựng state Jev từ dữ liệu đã tải (hàm thuần). Tin trước sắp theo created_at, id tăng dần. */
export function buildState(input: StateInput): JevState {
  const previous = [...input.previous]
    .filter(
      (p) =>
        p.row.createdAt < input.target.createdAt ||
        (p.row.createdAt.getTime() === input.target.createdAt.getTime() &&
          p.row.id < input.target.id),
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
      text: contentOf(input.target),
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
  ) {
    const at = target.createdAt;
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
            { createdAt: at, id: { lt: target.id } },
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
    const quote = (target.quote ?? null) as QuoteJson | null;
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
}
