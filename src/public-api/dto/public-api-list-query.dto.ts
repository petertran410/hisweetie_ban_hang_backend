import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Tham số truy vấn dùng chung cho mọi resource của Public API.
 *
 * Đặt tên bám theo tài liệu KiotViet Public API để đối tác đã quen KiotViet có
 * thể dùng lại client sẵn có:
 *  - `lastModifiedFrom` : mốc đồng bộ tăng dần (delta sync), đọc cột `updatedAt`.
 *  - `pageSize`         : mặc định 20, tối đa 100.
 *  - `currentItem`      : bỏ qua bao nhiêu bản ghi (offset), mặc định 0.
 *  - `orderBy` / `orderDirection` : sắp xếp, mặc định tăng dần.
 */
export class PublicApiListQueryDto {
  @IsOptional()
  @IsDateString()
  lastModifiedFrom?: string;

  /** Cận trên của mốc thời gian. Không có trong KiotViet, thêm để lấy theo khoảng. */
  @IsOptional()
  @IsDateString()
  lastModifiedTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  currentItem = 0;

  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'purchaseDate', 'orderDate', 'id', 'code', 'name'])
  orderBy?: string;

  @IsOptional()
  @Transform(({ value }) => String(value).toLowerCase())
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  branchIds?: string;

  @IsOptional()
  @IsString()
  customerIds?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  include?: string;
}
