import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

/** Query của GET /reports/smax/summary. CSV cho kênh / chi nhánh; bỏ trống = tất cả. */
export class SmaxSummaryQueryDto {
  /** ISO; bỏ trống = toàn thời gian. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** page_pid kênh Smax, phân tách dấu phẩy. */
  @IsOptional()
  @IsString()
  pagePids?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  /** Chi nhánh, phân tách dấu phẩy — chỉ áp dụng cho Độ phủ Zalo và Chat → Đơn. */
  @IsOptional()
  @IsString()
  branchIds?: string;
}
