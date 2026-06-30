import { PrismaService } from '../../prisma/prisma.service';

/**
 * Đọc env SEPAY_SPECIAL_ACCOUNT_NUMBERS (comma-separated) 1 lần ở module load.
 * Cache trong Set để tra cứu O(1).
 *
 * Ví dụ: SEPAY_SPECIAL_ACCOUNT_NUMBERS=96460248888,1234567890
 */
const SPECIAL_ACCOUNTS: Set<string> = (() => {
  const raw = process.env.SEPAY_SPECIAL_ACCOUNT_NUMBERS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
})();

/**
 * Kiểm tra giao dịch Sepay có thuộc tài khoản đặc biệt không.
 *
 * TK đặc biệt = Sepay gửi về `content` là nội dung gốc của khách
 * (không phải mã đơn/hóa đơn từ QR). Cần dùng để quyết định:
 *   - Lưu `transactionContent` (nội dung gốc) thay vì `referenceNumber` (mã TID)
 *     vào CashFlow.description khi kế toán tạo phiếu thu thủ công.
 *
 * Match nếu `accountNumber` HOẶC `subAccount` khớp bất kỳ giá trị nào trong env.
 *
 * Ví dụ BIDV: Sepay trả accountNumber = "8601539888", subAccount = "96460248888"
 * (VA). Env lưu "96460248888" → match theo subAccount.
 */
export async function isSepaySpecialAccount(
  prisma: PrismaService,
  accountNumber: string | null | undefined,
  subAccount: string | null | undefined,
): Promise<boolean> {
  if (SPECIAL_ACCOUNTS.size === 0) return false;
  if (!accountNumber && !subAccount) return false;
  if (accountNumber && SPECIAL_ACCOUNTS.has(accountNumber)) return true;
  if (subAccount && SPECIAL_ACCOUNTS.has(subAccount)) return true;
  return false;
}