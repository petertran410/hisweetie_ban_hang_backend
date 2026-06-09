import {
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Sale gán 1 hoặc nhiều khách hàng cho 1 giao dịch Sepay (chưa tạo phiếu thu). */
export class AssignCustomersDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Type(() => Number)
  customerIds!: number[];
}

/** Một dòng phân bổ tiền cho 1 khách khi tạo phiếu thu. */
export class AllocationItemDto {
  @IsInt()
  @Type(() => Number)
  customerId!: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * Kế toán xác nhận & tạo phiếu thu trừ công nợ từ giao dịch Sepay.
 * allocations: phân bổ số tiền cho từng khách (tổng = amountIn). Mỗi dòng → 1 phiếu thu.
 */
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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AllocationItemDto)
  allocations!: AllocationItemDto[];
}
