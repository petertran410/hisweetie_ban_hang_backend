import { isAckOnly, isStaffName } from '../../smax/wait-alerts';

/** Một dòng smax_messages (các cột cần cho luật). Cùng 1 tin nhóm có nhiều dòng (mỗi kênh trong nhóm 1 dòng). */
export type ArchiveRow = {
  id: bigint;
  pagePid: string;
  tid: string;
  msgPid: string;
  senderPid: string | null;
  senderName: string | null;
  fromMe: boolean;
  type: string;
  text: string;
  attachments: unknown;
  sticker: string | null;
  recalled: boolean;
  createdAt: Date;
};

/** Tin logic: mọi dòng cùng msg_pid; dòng đại diện (id nhỏ nhất) dùng để lấy ngữ cảnh. */
export type LogicalMessage = {
  msgPid: string;
  rep: ArchiveRow;
  rows: ArchiveRow[];
};

export type SkipReason =
  | 'staff'
  | 'order_report'
  | 'recalled'
  | 'media_only'
  | 'sticker_only'
  | 'empty'
  /** Hội thoại nằm trong danh sách loại trừ (smax_intel_exclusions) */
  | 'excluded'
  /** Thông báo hệ thống Zalo lưu như tin khách: "Bạn vừa kết bạn với …", "Cuộc gọi thoại đến …" */
  | 'system_notice'
  /** Đã gộp vào cụm tin liên tiếp của cùng khách (tin cuối cụm mới gửi AI) */
  | 'merged';

export type RuleDecision =
  | { status: 'skipped'; skipReason: SkipReason }
  | {
      status: 'completed';
      labels: {
        intent: 'acknowledgment';
        topics: string[];
        sentiment: 'neutral';
        urgency: 0;
        purchaseIntent: 0;
        requiresReply: false;
        requiresEscalation: false;
        isAnomaly: false;
      };
    }
  | { status: 'pending' };

// Tin báo đơn tự động của POS gửi vào nhóm khách ("🎉 Báo đơn BD… / Hoá đơn: HD…")
export const ORDER_REPORT = /Báo đơn BD\d+/;
// Thông báo Zalo lưu như tin thường: kết bạn, cuộc gọi thoại / video (đến, đi, nhỡ) kèm "📞<- 12 giây"
const SYSTEM_NOTICE =
  /^(?:Bạn vừa kết bạn với [^\n]+|Cuộc gọi(?: (?:thoại|video))?(?: (?:đến|đi|nhỡ))?\s*(?:📞[^\n]*)?)\s*$/u;

/** Thông báo hệ thống (kết bạn / cuộc gọi), không phải nội dung khách viết. */
export const isSystemNotice = (text: string) => SYSTEM_NOTICE.test(text.trim());

/** Gộp các dòng cùng msg_pid; bỏ tin hệ thống (không tạo job). Giữ thứ tự xuất hiện đầu tiên. */
export function groupByMsgPid(rows: ArchiveRow[]): LogicalMessage[] {
  const map = new Map<string, LogicalMessage>();
  for (const row of rows) {
    if (row.type === 'system') continue;
    const found = map.get(row.msgPid);
    if (!found)
      map.set(row.msgPid, { msgPid: row.msgPid, rep: row, rows: [row] });
    else {
      found.rows.push(row);
      if (row.id < found.rep.id) found.rep = row;
    }
  }
  return [...map.values()];
}

/**
 * Tin do phía công ty gửi: kênh Smax nào đó gửi (from_me ở bất kỳ dòng nào / người gửi là pid kênh của
 * công ty) hoặc Zalo cá nhân đặt tên theo thương hiệu (isStaffName). Không chắc chắn tuyệt đối — nhân viên
 * dùng tên khác sẽ bị coi là thành viên ngoài.
 */
export function isStaffMessage(
  rows: ArchiveRow[],
  ourPagePids: ReadonlySet<string>,
) {
  return rows.some(
    (r) =>
      r.fromMe ||
      (!!r.senderPid && ourPagePids.has(r.senderPid)) ||
      isStaffName(r.senderName),
  );
}

/** Bỏ qua theo nội dung tin khách (chỉ ảnh / sticker / trống): vẫn gom vào cụm, xét lại trên cả cụm. */
export const CONTENT_SKIPS: ReadonlySet<SkipReason> = new Set([
  'media_only',
  'sticker_only',
  'empty',
]);

const hasAttachments = (rows: ArchiveRow[]) =>
  rows.some((r) => Array.isArray(r.attachments) && r.attachments.length > 0);

/** Luật trước khi gọi Jev: bỏ qua / gắn nhãn ngay / chờ phân loại. */
export function decide(
  msg: LogicalMessage,
  ourPagePids: ReadonlySet<string>,
): RuleDecision {
  const { rows, rep } = msg;
  if (isStaffMessage(rows, ourPagePids))
    return { status: 'skipped', skipReason: 'staff' };
  const text = rep.text.trim();
  if (isSystemNotice(text))
    return { status: 'skipped', skipReason: 'system_notice' };
  if (ORDER_REPORT.test(text))
    return { status: 'skipped', skipReason: 'order_report' };
  if (rows.some((r) => r.recalled))
    return { status: 'skipped', skipReason: 'recalled' };
  if (!text) {
    if (hasAttachments(rows))
      return { status: 'skipped', skipReason: 'media_only' };
    if (rows.some((r) => r.sticker))
      return { status: 'skipped', skipReason: 'sticker_only' };
    return { status: 'skipped', skipReason: 'empty' };
  }
  // Chỉ xác nhận ("ok", "dạ", "cảm ơn em") và không kèm ảnh / tệp; câu có thêm nội dung vẫn đi Jev
  if (isAckOnly(text) && !hasAttachments(rows))
    return {
      status: 'completed',
      labels: {
        intent: 'acknowledgment',
        topics: [],
        sentiment: 'neutral',
        urgency: 0,
        purchaseIntent: 0,
        requiresReply: false,
        requiresEscalation: false,
        isAnomaly: false,
      },
    };
  return { status: 'pending' };
}
