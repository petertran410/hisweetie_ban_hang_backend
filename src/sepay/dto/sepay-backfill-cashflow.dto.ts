import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Backfill CashFlow.description cho các phiếu thu liên quan Sepay
 * (webhook + biến động số dư). Bỏ qua phiếu thu thủ công từ trang KH/sổ quỹ.
 *
 * Tiêu chí lọc phiếu thu liên quan Sepay (ít nhất 1 trong 4):
 *   1. CashFlow.sepayReferenceCode != null
 *   2. Có InvoicePayment với cashFlowId = cf.id (status != hủy)
 *   3. Có OrderPayment với cashFlowId = cf.id (status != hủy)
 *   4. Có SepayAllocation với cashFlowId = cf.id
 *
 * Nội dung mới:
 *   - TK đặc biệt (env SEPAY_SPECIAL_ACCOUNT_NUMBERS) → transactionContent
 *   - Ngân hàng khác → referenceNumber
 *
 * Cả 2 cách: preview (chỉ đọc) và apply (ghi DB).
 */
export class SepayBackfillCashflowDto {
  /** Giới hạn số phiếu thu xử lý / lần (mặc định 1000). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}
