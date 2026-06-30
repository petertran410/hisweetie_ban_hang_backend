import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Backfill transactionContent cho các sepay_transactions thuộc TK đặc biệt
 * (env SEPAY_SPECIAL_ACCOUNT_NUMBERS). Lấy lại content gốc từ rawPayload
 * và cập nhật transactionContent. KHÔNG đụng CashFlow.description.
 */
export class SepayBackfillDto {
  /** Giới hạn số record xử lý / lần (mặc định 1000). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}