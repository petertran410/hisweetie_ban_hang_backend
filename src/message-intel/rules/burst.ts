/**
 * Gom tin ngắn liên tiếp của cùng khách thành 1 cụm để AI hiểu cả đoạn (thay vì từng tin "Xót lắm", ":)))").
 * Cụm: tin khách liên tiếp trong 1 hội thoại, cùng người gửi, không có tin nhân viên / người khác / thông báo
 * xen giữa, tin sau cách tin trước ≤ 2 phút; cả cụm ≤ 10 phút, ≤ 20 tin, ≤ 1.500 ký tự. Tin cuối cụm gửi AI.
 */
export const BURST_GAP_MS = 120_000;
export const BURST_MAX_SPAN_MS = 10 * 60_000;
export const BURST_MAX_MESSAGES = 20;
export const BURST_MAX_CHARS = 1_500;
/** Cụm coi như đã xong khi tin cuối đã qua ngần này (khách không nhắn thêm, kho tin đã lưu kịp). */
export const BURST_SETTLE_MS = BURST_GAP_MS + 60_000;

export type BurstRow = {
  msgPid: string;
  senderPid: string | null;
  createdAt: Date;
  text: string;
  /** Tin khách có thể gộp (không phải nhân viên / thông báo / báo đơn) */
  member: boolean;
};

/**
 * Cụm chứa tin `msgPid` trong các tin của hội thoại (đã sắp theo thời gian, đã bỏ tin thu hồi). Chia chuỗi
 * liên tiếp từ tin đầu chuỗi theo giới hạn → cùng kết quả dù xét từ tin nào. `complete` = không còn tin nào
 * có thể nối thêm (đã có tin sau không nối được, đã chạm giới hạn, hoặc tin cuối đủ lâu).
 */
export function findBurst<T extends BurstRow>(
  rows: T[],
  msgPid: string,
  now: Date,
): { members: T[]; complete: boolean } | null {
  const i = rows.findIndex((r) => r.msgPid === msgPid);
  if (i < 0) return null;
  if (!rows[i].member) return { members: [rows[i]], complete: true };
  const joins = (a: T, b: T) =>
    a.member &&
    b.member &&
    a.senderPid === b.senderPid &&
    b.createdAt.getTime() - a.createdAt.getTime() <= BURST_GAP_MS;
  let start = i;
  while (start > 0 && joins(rows[start - 1], rows[start])) start--;
  let end = i;
  while (end + 1 < rows.length && joins(rows[end], rows[end + 1])) end++;
  // Chia chuỗi thành các cụm theo giới hạn, luôn tính từ tin đầu chuỗi
  let segStart = start;
  let chars = rows[start].text.length;
  let found: [number, number] | null = null;
  for (let k = start + 1; k <= end + 1; k++) {
    const over =
      k <= end &&
      (k - segStart + 1 > BURST_MAX_MESSAGES ||
        rows[k].createdAt.getTime() - rows[segStart].createdAt.getTime() >
          BURST_MAX_SPAN_MS ||
        chars + rows[k].text.length > BURST_MAX_CHARS);
    if (k > end || over) {
      if (segStart <= i && i <= k - 1) {
        found = [segStart, k - 1];
        break;
      }
      segStart = k;
      chars = k <= end ? rows[k].text.length : 0;
    } else chars += rows[k].text.length;
  }
  const [a, b] = found!;
  const last = rows[b];
  const complete =
    b < end ||
    b + 1 < rows.length ||
    now.getTime() - last.createdAt.getTime() >= BURST_SETTLE_MS;
  return { members: rows.slice(a, b + 1), complete };
}
