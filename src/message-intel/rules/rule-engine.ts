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
  | 'empty';

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
const ORDER_REPORT = /Báo đơn BD\d+/;

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
