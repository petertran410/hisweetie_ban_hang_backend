import { IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/** Sale gán khách hàng cho 1 giao dịch Sepay (chưa tạo phiếu thu). */
export class AssignCustomerDto {
  @IsInt()
  @Type(() => Number)
  customerId!: number;
}

/** Kế toán xác nhận & tạo phiếu thu trừ công nợ từ giao dịch Sepay. */
export class ConfirmReceiptDto {
  /** Chi nhánh hạch toán phiếu thu (kế toán đang chọn). Bắt buộc. */
  @IsInt()
  @Type(() => Number)
  branchId!: number;

  /** Optional override người thu (collector); mặc định là user hiện tại. */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  collectorUserId?: number;

  /** Optional ghi chú thêm cho phiếu thu. */
  @IsOptional()
  @IsString()
  description?: string;
}
