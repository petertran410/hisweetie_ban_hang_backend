import { IsInt, IsOptional, Min } from 'class-validator';

// POS: ghi Lịch sử khi chuyển khách sang bảng giá khách không thuộc.
// Bảng giá 0 hoặc bỏ trống = Bảng giá chung.
export class LogCustomerSwitchDto {
  @IsInt()
  @Min(1)
  customerId: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  fromPriceBookId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  toPriceBookId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  branchId?: number;
}
