import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

// ViewType nhóm báo cáo Cuối ngày.
export const EOD_VIEW_TYPES = [
  'Synthetic', // Tổng hợp cuối ngày
  'Document', // Chứng từ trong ngày (hóa đơn)
  'CashFlow', // Thu chi tiền trong ngày
  'Product', // Hàng bán trong ngày
] as const;

export type EodViewType = (typeof EOD_VIEW_TYPES)[number];

export class EodReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(EOD_VIEW_TYPES)
  viewType?: EodViewType;

  // Ngày báo cáo (yyyy-mm-dd). Mặc định hôm nay nếu không truyền.
  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
