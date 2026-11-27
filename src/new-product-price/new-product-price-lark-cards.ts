// Dựng card Lark (interactive) cho từng sự kiện — nội dung theo các workflow cũ
// trên Lark Base, nút bấm mở phiếu trên POS.
import { goodsPriceVnd, priceAnalysis, toNum } from './new-product-price.calc';
import { NppStage, STAGE_LABELS } from './new-product-price.constants';

import {
  TopicMention,
  TopicPost,
  actorText,
  buildTopicReplyPost,
} from '../lark-sync/lark-topic';

export type { TopicMention };

export type NppNotifyKind =
  | 'ENTER_PURCHASING'
  | 'SENT_BACK'
  | 'ENTER_ACCOUNTING'
  | 'KTT_REQUEST'
  | 'KTT_DECIDED'
  | 'ENTER_CEO'
  | 'TO_DATA'
  | 'CEO_REJECTED'
  | 'PRODUCT_CREATED';

export interface CardTicket {
  code: string;
  productName: string;
  parentName?: string | null;
  childName?: string | null;
  middleName?: string | null;
  tradeMarkName?: string | null;
  netWeightGram?: unknown;
  description?: string | null;
  note?: string | null;
  createdByName?: string | null;
  createdAt: Date;
  goodsPrice?: unknown;
  exchangeRate?: unknown;
  overheadCost?: unknown;
  costHn?: unknown;
  costSg?: unknown;
  cogsHn?: unknown;
  cogsSg?: unknown;
  cogsDt?: unknown;
  priceHnRetail?: unknown;
  priceHnWholesale?: unknown;
  priceSgRetail?: unknown;
  priceSgWholesale?: unknown;
  priceDlcl?: unknown;
  priceShopee?: unknown;
  priceOem?: unknown;
  productCode?: string | null;
}

export interface CardContext {
  link: string;
  /** Tên người nhận chính ("Gửi chị …"). */
  greetingNames?: string[];
  reason?: string | null;
  decision?: 'APPROVED' | 'REJECTED';
  decidedByName?: string | null;
  ended?: boolean;
  manufactured?: boolean;
}

export interface ReminderItem {
  code: string;
  productName: string;
  days: number;
}

const TZ = 'Asia/Ho_Chi_Minh';

/** Số kiểu en-US (108,000 đ) — giống lib/utils của frontend. */
export function fmtMoney(value: unknown): string {
  const n = toNum(value as any);
  if (n === null) return '—';
  return `${Math.round(n).toLocaleString('en-US')} đ`;
}

export function fmtNumber(value: unknown): string {
  const n = toNum(value as any);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtDate(value: Date | null | undefined): string {
  if (!value) return '—';
  return value.toLocaleDateString('vi-VN', { timeZone: TZ });
}

function fmtPercent(value: number | null): string {
  if (value === null) return '';
  return ` (lãi ${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%)`;
}

function text(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  return v === '' ? '—' : v;
}

function greeting(ctx: CardContext): string {
  const names = (ctx.greetingNames ?? []).filter(Boolean);
  return names.length ? `Gửi ${names.join(', ')},\n` : '';
}

function baseLines(t: CardTicket): string[] {
  return [
    `**Mã phiếu:** ${t.code}`,
    `**Ngày đề xuất:** ${fmtDate(t.createdAt)}`,
    `**Người đề xuất:** ${text(t.createdByName)}`,
    `**Tên hàng hóa:** <font color='green'>${text(t.productName)}</font>`,
    `**Loại hàng:** ${text(t.parentName)}`,
    `**Thương hiệu:** ${text(t.tradeMarkName)}`,
    `**Danh mục hàng:** ${text(t.childName)}`,
  ];
}

function costLines(t: CardTicket): string[] {
  return [
    `**Mã phiếu:** ${t.code}`,
    `**Người đề xuất:** ${text(t.createdByName)} — ${fmtDate(t.createdAt)}`,
    `**Tên hàng hóa:** <font color='green'>${text(t.productName)}</font>`,
    `**Nguồn hàng:** ${text(t.middleName)}`,
    `**Mô tả sản phẩm:** ${text(t.description)}`,
    `**Khối lượng tịnh (gram):** ${fmtNumber(t.netWeightGram)}`,
    `**Giá hàng VNĐ:** ${fmtMoney(goodsPriceVnd(t as any))}`,
    `**Chi phí chung:** ${fmtMoney(t.overheadCost)}`,
    `**Cost Hà Nội (trước VAT):** ${fmtMoney(t.costHn)}`,
    `**Cost Sài Gòn (trước VAT):** ${fmtMoney(t.costSg)}`,
  ];
}

function priceLines(t: CardTicket): string[] {
  const rows = Object.fromEntries(
    priceAnalysis(t as any).map((r) => [r.key, r]),
  );
  return [
    `**Mã phiếu:** ${t.code}`,
    `**Tên sản phẩm:** <font color='green'>${text(t.productName)}</font>`,
    `**HN - Giá lẻ:** ${fmtMoney(t.priceHnRetail)}${fmtPercent(rows.HN_RETAIL.margin)}`,
    `**HN - Giá sỉ:** ${fmtMoney(t.priceHnWholesale)}${fmtPercent(rows.HN_WHOLESALE.margin)}`,
    `**HCM - Giá lẻ:** ${fmtMoney(t.priceSgRetail)}${fmtPercent(rows.SG_RETAIL.margin)}`,
    `**HCM - Giá sỉ:** ${fmtMoney(t.priceSgWholesale)}${fmtPercent(rows.SG_WHOLESALE.margin)}`,
    `**Giá Shopee:** ${fmtMoney(t.priceShopee)}${fmtPercent(rows.SHOPEE.margin)}`,
  ];
}

function card(
  title: string,
  template: string,
  content: string,
  buttons: { label: string; url: string; primary?: boolean }[],
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
          type: b.primary === false ? 'default' : 'primary',
          url: b.url,
        })),
      },
    ],
  };
}

export interface BuiltCard {
  title: string;
  body: string;
  card: Record<string, unknown>;
  /** Câu đề nghị (dùng lại cho tin trong chủ đề nhóm). */
  ask?: string;
}

/** Card cho sự kiện của 1 phiếu. `body` = bản rút gọn dùng cho thông báo trong app. */
export function buildTicketCard(
  kind: NppNotifyKind,
  t: CardTicket,
  ctx: CardContext,
): BuiltCard {
  const view = [{ label: 'Xem bản ghi chi tiết', url: ctx.link }];
  const hi = greeting(ctx);
  let title: string;
  let template = 'blue';
  let lines: string[];
  let ask: string;
  let buttons = view;

  switch (kind) {
    case 'ENTER_PURCHASING':
      title = 'Thông báo đề xuất sản phẩm mới';
      lines = [...baseLines(t), `**Ghi chú:** ${text(t.note)}`];
      ask =
        'Đề nghị Phòng thu mua bổ sung thông tin và chi phí thu mua của sản phẩm.';
      break;
    case 'SENT_BACK':
      title = 'Yêu cầu bổ sung thông tin sản phẩm mới';
      template = 'orange';
      lines = [...baseLines(t), `**Lý do trả về:** ${text(ctx.reason)}`];
      ask =
        'Đề nghị Phòng thu mua kiểm tra, bổ sung thông tin và chi phí thu mua của sản phẩm.';
      break;
    case 'ENTER_ACCOUNTING':
      title = 'Kế toán xử lý giá vốn sản phẩm mới';
      lines = costLines(t);
      ask =
        'Đề nghị Kế toán kiểm tra giá vốn từ thu mua và hoàn thiện giá vốn của sản phẩm.';
      break;
    case 'KTT_REQUEST':
      title = 'Kế toán trưởng duyệt giá vốn sản phẩm mới';
      template = 'orange';
      lines = [
        ...costLines(t),
        `**Giá vốn Hà Nội:** ${fmtMoney(t.cogsHn)}`,
        `**Giá vốn Sài Gòn:** ${fmtMoney(t.cogsSg)}`,
        `**Giá vốn CH Diệp Trà:** ${fmtMoney(t.cogsDt)}`,
      ];
      ask = 'Đề nghị Kế toán trưởng kiểm tra, duyệt giá vốn của sản phẩm mới.';
      buttons = [{ label: 'Mở phiếu để duyệt', url: ctx.link }];
      break;
    case 'KTT_DECIDED': {
      const ok = ctx.decision === 'APPROVED';
      title = ok
        ? 'Kế toán trưởng đã duyệt giá vốn sản phẩm mới'
        : 'Kế toán trưởng từ chối giá vốn sản phẩm mới';
      template = ok ? 'green' : 'red';
      lines = [
        `**Mã phiếu:** ${t.code}`,
        `**Tên hàng hóa:** <font color='green'>${text(t.productName)}</font>`,
        `**Người duyệt:** ${text(ctx.decidedByName)}`,
        ...(ctx.reason ? [`**Ghi chú:** ${ctx.reason}`] : []),
      ];
      ask = ok
        ? 'Phòng Kế toán tiếp tục hoàn tất bước giá vốn.'
        : 'Đề nghị Phòng Kế toán kiểm tra lại giá vốn và gửi duyệt lại.';
      break;
    }
    case 'ENTER_CEO':
      title = 'CEO duyệt giá bán sản phẩm mới';
      template = 'orange';
      lines = priceLines(t);
      ask =
        'Phòng kinh doanh đã cập nhật giá sản phẩm mới. Đề nghị CEO duyệt bảng giá.';
      buttons = [{ label: 'Mở phiếu để duyệt', url: ctx.link }];
      break;
    case 'TO_DATA':
      title = ctx.manufactured
        ? 'Hàng sản xuất đã đủ thông tin — tạo sản phẩm mới'
        : 'CEO đã duyệt giá bán sản phẩm mới';
      template = 'green';
      lines = [
        `**Mã phiếu:** ${t.code}`,
        `**Tên hàng hóa:** <font color='green'>${text(t.productName)}</font>`,
        `**Ngày đề xuất:** ${fmtDate(t.createdAt)}`,
      ];
      ask =
        'Team Data tiến hành tạo sản phẩm mới trên POS (nút "Áp dụng tạo sản phẩm mới").';
      break;
    case 'CEO_REJECTED':
      title = 'CEO đã từ chối đề xuất sản phẩm mới';
      template = 'red';
      lines = [
        `**Mã phiếu:** ${t.code}`,
        `**Tên hàng hóa:** <font color='green'>${text(t.productName)}</font>`,
        `**Ngày đề xuất:** ${fmtDate(t.createdAt)}`,
        `**Lý do:** ${text(ctx.reason)}`,
      ];
      ask = ctx.ended
        ? 'Phiếu đề xuất đã được kết thúc.'
        : 'Đề nghị phòng thu mua kiểm tra và đề xuất lại.';
      break;
    case 'PRODUCT_CREATED':
      title = 'Sản phẩm mới đã được tạo';
      template = 'green';
      lines = [
        `**Mã phiếu:** ${t.code}`,
        `**Mã hàng:** ${text(t.productCode)}`,
        `**Tên sản phẩm:** <font color='green'>${text(t.productName)}</font>`,
        `**Thương hiệu:** ${text(t.tradeMarkName)}`,
        `**Giá vốn HN / SG / CH Diệp Trà:** ${fmtMoney(t.cogsHn)} / ${fmtMoney(t.cogsSg)} / ${fmtMoney(t.cogsDt)}`,
        `**Giá bán HN lẻ / sỉ:** ${fmtMoney(t.priceHnRetail)} / ${fmtMoney(t.priceHnWholesale)}`,
        `**Giá bán HCM lẻ / sỉ:** ${fmtMoney(t.priceSgRetail)} / ${fmtMoney(t.priceSgWholesale)}`,
      ];
      ask = 'Sản phẩm mới đã được tạo trên POS kèm giá vốn và giá bán.';
      break;
    default:
      title = 'Bảng giá sản phẩm mới';
      lines = baseLines(t);
      ask = '';
  }

  const content = `${hi}${lines.join('\n')}\n\n${ask}`.trim();
  return {
    title,
    body: `${t.code} — ${t.productName}. ${ask}`.trim(),
    card: card(title, template, content, buttons),
    ask,
  };
}

/** Tin mở chủ đề của phiếu trong nhóm Lark (dạng chủ đề) — gửi 1 lần khi phiếu được gửi đi. */
export function buildTopicRootCard(
  t: CardTicket,
  link: string,
): Record<string, unknown> {
  const content = [
    `**${text(t.createdByName)}** vừa đề xuất sản phẩm mới.`,
    '',
    ...baseLines(t),
    `**Ghi chú:** ${text(t.note)}`,
    '',
    'Các bước xử lý của phiếu được cập nhật trong chủ đề này.',
  ].join('\n');
  return card(
    `Đề xuất sản phẩm mới ${t.code} — ${text(t.productName)}`,
    'blue',
    content,
    [{ label: 'Xem phiếu', url: link }],
  );
}

export interface TopicReplyContext {
  /** Link mở phiếu (có &open=1 khi người nhận cần xử lý). */
  link: string;
  /** Người phụ trách bước mới — tag tất cả, kể cả người vừa thao tác. */
  mentions: TopicMention[];
  /** Người vừa thao tác. */
  actorName?: string | null;
  reason?: string | null;
  decision?: 'APPROVED' | 'REJECTED';
  decidedByName?: string | null;
  ended?: boolean;
  manufactured?: boolean;
  productCode?: string | null;
}

/**
 * Tin trả lời trong chủ đề khi phiếu tới bước mới — dạng tin nhắn (post), chuẩn chung
 * ở lark-sync/lark-topic.ts: tiêu đề = tiêu đề tin riêng của bước · hàng tag ·
 * "**Người làm** (vai trò) đã …" · "**Lý do:** …" · câu đề nghị của tin riêng · link.
 */
export function buildTopicReply(
  kind: NppNotifyKind,
  built: BuiltCard,
  ctx: TopicReplyContext,
): TopicPost {
  const by = (role?: string) =>
    actorText(ctx.decidedByName || ctx.actorName, role);
  const approved = ctx.decision === 'APPROVED';
  let done: string;
  switch (kind) {
    case 'ENTER_PURCHASING':
      done = `${by('Người đề xuất')} đã gửi đề xuất.`;
      break;
    case 'SENT_BACK':
      done = `${by()} trả về phiếu.`;
      break;
    case 'ENTER_ACCOUNTING':
      done = `${by('Phòng Thu Mua')} đã hoàn tất bước.`;
      break;
    case 'KTT_REQUEST':
      done = `${by('Phòng Kế Toán')} đã gửi Kế toán trưởng duyệt.`;
      break;
    case 'KTT_DECIDED':
      done = `${by('Kế toán trưởng')} ${approved ? 'đã duyệt' : 'từ chối'} giá vốn.`;
      break;
    case 'ENTER_CEO':
      done = `${by('Phòng Kinh Doanh')} đã cập nhật giá bán.`;
      break;
    case 'TO_DATA':
      done = ctx.manufactured
        ? `${by('Phòng Kinh Doanh')} đã hoàn tất (hàng sản xuất, không cần CEO duyệt).`
        : `${by('CEO')} đã duyệt bảng giá.`;
      break;
    case 'CEO_REJECTED':
      done = `${by('CEO')} từ chối.`;
      break;
    case 'PRODUCT_CREATED':
      done = `${by('Phòng Dữ Liệu')} đã tạo sản phẩm${ctx.productCode ? ` **${ctx.productCode}**` : ''} trên POS.`;
      break;
    default:
      done = '';
  }
  const reason = ctx.reason
    ? `**${kind === 'KTT_DECIDED' && approved ? 'Ghi chú' : 'Lý do'}:** ${ctx.reason}`
    : '';
  const viewOnly =
    kind === 'PRODUCT_CREATED' || (kind === 'CEO_REJECTED' && !!ctx.ended);
  return buildTopicReplyPost({
    title: built.title,
    mentions: ctx.mentions,
    lines: [done, reason, built.ask ?? ''],
    link: {
      label: viewOnly ? 'Xem phiếu' : 'Mở phiếu để xử lý',
      url: ctx.link,
    },
  });
}

/** Card nhắc việc hằng ngày cho một bước. */
export function buildReminderCard(
  stage: NppStage,
  items: ReminderItem[],
  listLink: string,
  greetingNames: string[] = [],
): BuiltCard {
  const label = STAGE_LABELS[stage];
  const shown = items.slice(0, 20);
  const more = items.length - shown.length;
  const hi = greetingNames.length ? `Gửi ${greetingNames.join(', ')},\n` : '';
  const lines = shown.map(
    (i) => `• ${i.code} – ${i.productName} (${i.days} ngày)`,
  );
  if (more > 0) lines.push(`… và ${more} phiếu khác`);
  const title = 'Thông báo từ Bảng giá sản phẩm mới';
  const head = `Bảng giá sản phẩm mới **Đang chờ xử lý** tại **${label}** (${items.length} phiếu). Vui lòng kiểm tra và hoàn tất để sản phẩm được đăng bán.`;
  return {
    title,
    body: `${items.length} phiếu đang chờ xử lý tại ${label}`,
    card: card(title, 'orange', `${hi}${head}\n\n${lines.join('\n')}`, [
      { label: 'Xem danh sách', url: listLink, primary: false },
    ]),
  };
}
