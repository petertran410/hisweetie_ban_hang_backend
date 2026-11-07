import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString } from 'class-validator';

/** Query của GET /reports/leads/summary — cùng quy ước với GET /leads (CSV cho nguồn / phân loại). */
export class LeadSummaryQueryDto {
  /** ISO; bỏ trống = toàn thời gian. Lọc theo ngày tạo lead. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // Danh sách, phân tách dấu phẩy
  @IsOptional()
  @IsString()
  sources?: string;

  @IsOptional()
  @IsString()
  categories?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cskhUserId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  salePicId?: number;
}
