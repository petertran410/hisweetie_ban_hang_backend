/**
 * Cảnh báo khách chờ lâu trong "Đang chat gần đây" (không dùng AI).
 * Giờ làm theo giờ Việt Nam: Thứ 2–Thứ 6 8:00–18:00, Thứ 7 8:00–12:00, Chủ nhật nghỉ.
 */

/** Ngưỡng báo: khách chờ quá chừng này phút giờ làm. */
export const WAIT_ALERT_MINUTES = 30;
/** Chỉ xét tin khách nhắn trong chừng này ngày gần nhất. */
export const WAIT_LOOKBACK_DAYS = 3;

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** Giờ làm của một ngày theo thứ (0 = Chủ nhật), tính bằng giờ: [bắt đầu, kết thúc]. */
function workingHours(weekday: number): [number, number] | null {
  if (weekday === 0) return null;
  if (weekday === 6) return [8, 12];
  return [8, 18];
}

/** Số phút giờ làm (giờ VN) nằm giữa `from` và `to`. */
export function workingMinutes(from: Date, to: Date): number {
  const start = from.getTime() + VN_OFFSET_MS;
  const end = to.getTime() + VN_OFFSET_MS;
  if (!(end > start)) return 0;
  let total = 0;
  // Duyệt từng ngày (theo giờ VN, biểu diễn bằng UTC đã cộng 7 giờ), tối đa 31 ngày
  let day = Math.floor(start / DAY_MS) * DAY_MS;
  for (let i = 0; day < end && i < 31; i++, day += DAY_MS) {
    const hours = workingHours(new Date(day).getUTCDay());
    if (!hours) continue;
    const open = day + hours[0] * 3_600_000;
    const close = day + hours[1] * 3_600_000;
    const overlap = Math.min(close, end) - Math.max(open, start);
    if (overlap > 0) total += overlap;
  }
  return Math.floor(total / 60_000);
}

// Lời khách có vẻ sốt ruột / bực (so khớp không dấu)
const UPSET = new RegExp(
  [
    'chua (gui|giao|thay|nhan|tra loi|rep|ship|co hang)',
    'sao (lau|chua|vay|the)',
    'lau (qua|the|vay)',
    'bao gio (moi|thi)',
    'buc',
    'that vong',
    'te qua',
    'kem qua',
    'huy don',
    'khong (hai long|mua nua|lay nua)',
    'tra lai',
    'hoan tien',
    'loi (roi|qua)',
    'hu (het|roi)',
  ].join('|'),
);

const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

/** Tin cuối của khách có dấu hiệu sốt ruột / bực (từ khoá, hoặc "??" / "!!"). */
export function looksUpset(text: string): boolean {
  if (!text) return false;
  return UPSET.test(fold(text)) || /[?!]{2,}/.test(text);
}

// Nhân viên trong nhóm Zalo khách thường dùng Zalo cá nhân đặt tên theo thương hiệu
// ("Diệp Trà - Mr Sĩ Phú", "Diệp Trà Kênh Bán Sỉ", "Kế Toán Diệp Trà") — không phải kênh Smax.
const STAFF_NAME = /(^|[^a-z])(diep tra|lermao|hi ?sweetie|ke toan)([^a-z]|$)/;

/** Tên thành viên nhóm là nhân viên công ty (theo tên thương hiệu trong tên Zalo). */
export function isStaffName(name: string | null | undefined): boolean {
  return !!name && STAFF_NAME.test(fold(name));
}

// Tin chỉ để xác nhận / cảm ơn, không cần trả lời
const ACK_WORDS = new Set(
  'ok oke okie oki okay vang da u uh uk o duoc dc dung roi r cam on thanks thank tks you a ah e em chi c anh ban b nha nhe nhen oi ha ne luon nhieu'.split(
    ' ',
  ),
);

/** Tin ngắn chỉ gồm từ xác nhận ("Vâng", "Đúng r e ơi", "ok cảm ơn em") — không cần trả lời. */
export function isAckOnly(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 40 || t.includes('?') || t === 'attach') return false;
  const folded = fold(t);
  // Cười ("kkkk", "haha", "hihi") hoặc lời cảm ơn ngắn (kể cả kèm @tag nhân viên)
  if (
    /^(k{2,}|(ha){2,}|(hi){2,}|(he){2,})[!. ]*$/.test(folded) ||
    /\b(cam on|thanks?|tks)\b/.test(folded)
  )
    return true;
  const words = folded
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Chỉ emoji / dấu câu (vd "👍") cũng coi là xác nhận
  return words.every((w) => ACK_WORDS.has(w));
}

/** Nhóm cộng đồng nhiều khách (vd "CỘNG ĐỒNG LERMAO BẾN TRE") — không cảnh báo chờ trả lời. */
export function isCommunityGroup(name: string): boolean {
  return /^cong dong\b/.test(fold(name).trim());
}
