// Dựng card Lark (interactive) cho từng sự kiện của phiếu thay đổi giá; nút mở phiếu trên POS.
import { cellDiff, toNum } from './price-change.calc';
import type { CostLine, PriceLine } from './price-change.constants';
import {
  actorText,
  buildTopicReplyPost,
  type TopicMention,
} from '../lark-sync/lark-topic';

export type PcNotifyKind =
  | 'TO_KTT'
  | 'TO_CEO'
  | 'TO_DATA'
  | 'REJECTED'
  | 'SENT_BACK'
  | 'APPLIED';

export interface CardItem {
  productCode: string;
  productName: string;
  costs: CostLine[];
  prices: PriceLine[];
}

export interface CardTicket {
  code: string;
  createdByName?: string | null;
  createdAt: Date;
  note?: string | null;
  hasCost: boolean;
  hasSale: boolean;
  items: CardItem[];
}

export interface CardContext {
  link: string;
  /** Tên người nhận chính ("Gửi …"). */
  greetingNames?: string[];
  reason?: string | null;
  decidedByName?: string | null;
  /** Bước của người từ chối (Kế toán trưởng / CEO). */
  decidedByRole?: string | null;
  ended?: boolean;
}

export interface BuiltCard {
  title: string;
  body: string;
  card: Record<string, unknown>;
}

const TZ = 'Asia/Ho_Chi_Minh';
const MAX_PRODUCTS = 10;

/** Số kiểu en-US (108,000) — giống lib/utils của frontend. */
export function fmtMoney(value: unknown): string {
  const n = toNum(value);
  if (n === null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtDate(value: Date): string {
  return value.toLocaleDateString('vi-VN', { timeZone: TZ });
}

function text(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  return v === '' ? '—' : v;
}

/** "100,000 → 110,000 (+10%)" — chưa có giá cũ thì chỉ hiện giá mới. */
export function changeText(oldValue: unknown, newValue: unknown): string {
  const { diff, ratio } = cellDiff(oldValue, newValue);
  if (diff === null) return `→ ${fmtMoney(newValue)}`;
  const arrow = diff > 0 ? '⬆️' : diff < 0 ? '⬇️' : '🟡';
  const pct =
    ratio === null
      ? ''
      : ` ${ratio > 0 ? '+' : ''}${(ratio * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  return `${fmtMoney(oldValue)} → ${fmtMoney(newValue)} (${arrow}${pct})`;
}

export function typeLabel(t: Pick<CardTicket, 'hasCost' | 'hasSale'>): string {
  return [t.hasCost && 'Giá vốn', t.hasSale && 'Giá bán']
    .filter(Boolean)
    .join(' + ');
}

function itemLines(items: CardItem[]): string[] {
  const lines: string[] = [];
  for (const item of items.slice(0, MAX_PRODUCTS)) {
    lines.push(
      `• **${item.productCode}** <font color='green'>${text(item.productName)}</font>`,
    );
    for (const c of item.costs) {
      if (c.newCost === null) continue;
      lines.push(
        `    Giá vốn ${c.branchName}: ${changeText(c.oldCost, c.newCost)}`,
      );
    }
    for (const p of item.prices) {
      if (p.newPrice === null) continue;
      lines.push(
        `    ${p.priceBookName}: ${changeText(p.oldPrice, p.newPrice)}`,
      );
    }
  }
  const more = items.length - MAX_PRODUCTS;
  if (more > 0) lines.push(`… và ${more} sản phẩm khác`);
  return lines;
}

function baseLines(t: CardTicket): string[] {
  return [
    `**Mã phiếu:** ${t.code}`,
    `**Người đề xuất:** ${text(t.createdByName)} — ${fmtDate(t.createdAt)}`,
    `**Loại thay đổi:** ${typeLabel(t)} · ${t.items.length} sản phẩm`,
    `**Ghi chú:** ${text(t.note)}`,
  ];
}

function card(
  title: string,
  template: string,
  content: string,
  buttons: { label: string; url: string }[],
) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      {
        tag: 'action',
        actions: buttons.map((b) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: 'primary',
          url: b.url,
        })),
      },
    ],
  };
}

/** Card cho sự kiện của 1 phiếu. `body` = bản rút gọn cho thông báo trong app. */
export function buildTicketCard(
  kind: PcNotifyKind,
  t: CardTicket,
  ctx: CardContext,
): BuiltCard {
  const names = (ctx.greetingNames ?? []).filter(Boolean);
  const hi = names.length ? `Gửi ${names.join(', ')},\n` : '';
  let title: string;
  let template = 'blue';
  let extra: string[] = [];
  let ask: string;
  let button = 'Mở phiếu để duyệt';

  switch (kind) {
    case 'TO_KTT':
      title = 'Kế toán trưởng duyệt thay đổi giá';
      ask = 'Đề nghị Kế toán trưởng kiểm tra và duyệt thay đổi giá.';
      break;
    case 'TO_CEO':
      title = 'CEO duyệt thay đổi giá vốn';
      ask = 'Kế toán trưởng đã duyệt. Đề nghị CEO duyệt thay đổi giá.';
      break;
    case 'TO_DATA':
      title = 'Phòng Dữ Liệu áp dụng thay đổi giá';
      template = 'turquoise';
      ask =
        'Phiếu đã được duyệt. Đề nghị Phòng Dữ Liệu áp dụng giá mới trên POS.';
      button = 'Mở phiếu để áp dụng';
      break;
    case 'REJECTED':
      title = 'Thay đổi giá bị từ chối';
      template = 'red';
      extra = [
        `**Người từ chối:** ${text(ctx.decidedByName)}${ctx.decidedByRole ? ` (${ctx.decidedByRole})` : ''}`,
        `**Lý do:** ${text(ctx.reason)}`,
      ];
      ask = ctx.ended
        ? 'Phiếu đã được kết thúc.'
        : 'Đề nghị kiểm tra, chỉnh sửa và gửi duyệt lại.';
      button = 'Xem phiếu';
      break;
    case 'SENT_BACK':
      title = 'Phòng Dữ Liệu trả về phiếu thay đổi giá';
      template = 'orange';
      extra = [`**Lý do trả về:** ${text(ctx.reason)}`];
      ask = 'Đề nghị kiểm tra, chỉnh sửa và gửi duyệt lại.';
      button = 'Xem phiếu';
      break;
    case 'APPLIED':
      title = 'Đã áp dụng thay đổi giá';
      template = 'green';
      ask = 'Giá mới đã được áp dụng trên POS.';
      button = 'Xem phiếu';
      break;
  }

  const content =
    `${hi}${[...baseLines(t), ...extra].join('\n')}\n\n${itemLines(t.items).join('\n')}\n\n${ask}`.trim();
  return {
    title,
    body: `${t.code} — ${typeLabel(t)}, ${t.items.length} sản phẩm. ${ask}`.trim(),
    card: card(title, template, content, [{ label: button, url: ctx.link }]),
  };
}

// ───────────── Nhắc việc hằng ngày (tin riêng, 1 tin / bước) ─────────────

export interface ReminderItem {
  code: string;
  hasCost: boolean;
  hasSale: boolean;
  itemCount: number;
  /** Sản phẩm đầu tiên của phiếu ("SP007648 Siro …"). */
  firstProduct: string | null;
  /** Số ngày đã chờ ở bước hiện tại. */
  days: number;
}

const MAX_REMINDER_ROWS = 20;

/** Tin tổng hợp các phiếu đang chờ ở 1 bước (khuôn nhắc việc của Bảng giá SP mới). */
export function buildReminderCard(
  stageLabel: string,
  items: ReminderItem[],
  listLink: string,
  greetingNames: string[] = [],
): BuiltCard {
  const shown = items.slice(0, MAX_REMINDER_ROWS);
  const more = items.length - shown.length;
  const hi = greetingNames.length ? `Gửi ${greetingNames.join(', ')},\n` : '';
  const lines = shown.map((i) => {
    const product = i.firstProduct
      ? ` · ${i.firstProduct}${i.itemCount > 1 ? ` +${i.itemCount - 1} SP` : ''}`
      : ` · ${i.itemCount} SP`;
    return `• **${i.code}** – ${typeLabel(i)}${product} (${i.days} ngày)`;
  });
  if (more > 0) lines.push(`… và ${more} phiếu khác`);
  const title = 'Nhắc việc: Thay đổi giá sản phẩm';
  const head = `Phiếu thay đổi giá **đang chờ xử lý** tại **${stageLabel}** (${items.length} phiếu). Vui lòng kiểm tra và xử lý để giá mới được áp dụng.`;
  return {
    title,
    body: `${items.length} phiếu thay đổi giá đang chờ xử lý tại ${stageLabel}`,
    card: card(title, 'orange', `${hi}${head}\n\n${lines.join('\n')}`, [
      { label: 'Xem danh sách', url: listLink },
    ]),
  };
}

// ───────────── Nhóm Lark dạng topic: 1 topic / phiếu, mỗi bước 1 trả lời ─────────────
// Bố cục tin theo chuẩn chung của các luồng duyệt: lark-sync/lark-topic.ts

export interface GroupReplyContext {
  link: string;
  /** Người phụ trách bước mới (được tag). */
  mentions: TopicMention[];
  /** Topic đã có sẵn khi gửi Kế toán trưởng = người đề xuất gửi lại sau khi bị trả về. */
  resubmit?: boolean;
  reason?: string | null;
  decidedByName?: string | null;
  decidedByRole?: string | null;
  ended?: boolean;
}

/** Tin mở đầu topic của phiếu trong nhóm. */
export function buildGroupRootCard(t: CardTicket, link: string) {
  const content =
    `${baseLines(t).join('\n')}\n\n${itemLines(t.items).join('\n')}`.trim();
  return card(`Đề xuất thay đổi giá ${t.code}`, 'blue', content, [
    { label: 'Xem phiếu', url: link },
  ]);
}

/**
 * Trả lời trong chủ đề khi phiếu tới bước mới — dạng tin nhắn (post) như Bảng giá SP mới:
 * tiêu đề · tag người phụ trách · nội dung "Đề nghị …" · link mở phiếu.
 */
export function buildGroupReply(kind: PcNotifyKind, ctx: GroupReplyContext) {
  const by = actorText(ctx.decidedByName, ctx.decidedByRole);
  const reason = `**Lý do:** ${text(ctx.reason)}`;
  let title: string;
  let lines: string[];
  let label: 'Mở phiếu để xử lý' | 'Xem phiếu' = 'Mở phiếu để xử lý';

  switch (kind) {
    case 'TO_KTT':
      title = 'Kế toán trưởng duyệt thay đổi giá';
      lines = [
        `${by} ${ctx.resubmit ? 'đã sửa và gửi lại phiếu' : 'đã gửi đề xuất'}.`,
        'Đề nghị Kế toán trưởng kiểm tra và duyệt thay đổi giá.',
      ];
      break;
    case 'TO_CEO':
      title = 'CEO duyệt thay đổi giá vốn';
      lines = [`${by} đã duyệt.`, 'Đề nghị CEO duyệt thay đổi giá vốn.'];
      break;
    case 'TO_DATA':
      title = 'Phòng Dữ Liệu áp dụng thay đổi giá';
      lines = [
        `${by} đã duyệt.`,
        'Đề nghị Phòng Dữ Liệu áp dụng giá mới trên POS.',
      ];
      break;
    case 'REJECTED':
      title = 'Thay đổi giá bị từ chối';
      lines = [
        `${by} từ chối.`,
        reason,
        ctx.ended
          ? 'Phiếu đã kết thúc.'
          : 'Đề nghị người đề xuất kiểm tra, chỉnh sửa và gửi duyệt lại.',
      ];
      label = 'Xem phiếu';
      break;
    case 'SENT_BACK':
      title = 'Phòng Dữ Liệu trả về phiếu thay đổi giá';
      lines = [
        `${by} trả về phiếu.`,
        reason,
        'Đề nghị người đề xuất kiểm tra, chỉnh sửa và gửi duyệt lại.',
      ];
      label = 'Xem phiếu';
      break;
    case 'APPLIED':
      title = 'Đã áp dụng thay đổi giá';
      lines = [`${by} đã áp dụng giá mới trên POS. Phiếu hoàn thành.`];
      label = 'Xem phiếu';
      break;
  }

  return buildTopicReplyPost({
    title,
    mentions: ctx.mentions,
    lines,
    link: { label, url: ctx.link },
  });
}
