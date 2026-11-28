/**
 * Làm tròn tiền 2 số thập phân.
 *
 * Tiền POS giữ tối đa 2 số lẻ (vd SP007601: 120,000 ÷ 1,08 = 111,111.11). Cộng /
 * trừ số thực trong JS hay sinh đuôi lẻ (0.1 + 0.2 = 0.30000000000000004); cột
 * tiền kiểu Decimal không giới hạn số lẻ sẽ lưu nguyên đuôi đó, và các phép so
 * sánh kiểu `debtAmount <= 0` có thể sai. Làm tròn mọi tổng tiền trước khi ghi DB.
 */
export const roundMoney = (value: number): number =>
  Math.round(value * 100) / 100;
