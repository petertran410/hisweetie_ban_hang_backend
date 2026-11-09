import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ANALYTICS_AXES, AnalyticsAxis } from '../dto';

// Query chung các trang Phân tích › Khách Hàng: ĐLCL Lermao / Mứt Lermao / Boduo /
// Phượng Hoàng, Biên Thương Mại, Chi Tiết, Xuất Data (thay các slicer Power BI).

export const DLCL_METRICS = [
  'amount',
  'orders',
  'quantity',
  'customers',
] as const;
export type DlclMetric = (typeof DLCL_METRICS)[number];

export const DLCL_COLUMN_MODES = ['month', 'week'] as const;
export type DlclColumnMode = (typeof DLCL_COLUMN_MODES)[number];

/** Giai đoạn mở bán sản phẩm (dim_product[new_product_phase]). */
export const PRODUCT_PHASES = [
  'Mới (0-30 ngày)',
  'Giai đoạn 2 (31-60 ngày)',
  'Giai đoạn 3 (61-90 ngày)',
  'Ngoài 90 ngày',
  'Không Bán',
] as const;

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

export class AnalyticsDlclQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2022)
  @Max(2100)
  year!: number;

  /** Trang Xuất Data: nhiều năm (bỏ trống = chỉ `year`). */
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(2022, { each: true })
  @Max(2100, { each: true })
  years?: number[];

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  months?: number[];

  /** "Tính toán bởi" (view_by[mode]). */
  @IsOptional()
  @IsIn(DLCL_METRICS)
  metric?: DlclMetric;

  /** Trục thời gian biểu đồ xu hướng (auto_period / Ngày-Thứ-Tháng). */
  @IsOptional()
  @IsIn(ANALYTICS_AXES)
  axis?: AnalyticsAxis;

  /** Trang Chi Tiết: cột của bảng tổng hợp theo tháng hay theo tuần. */
  @IsOptional()
  @IsIn(DLCL_COLUMN_MODES)
  columns?: DlclColumnMode;

  // ── Slicer khách ──
  @IsOptional()
  @IsString()
  customerType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerGroupId?: number;

  @IsOptional()
  @IsString()
  parentName?: string;

  @IsOptional()
  @IsString()
  region?: string;

  // ── Slicer hàng ──
  @IsOptional()
  @IsString()
  productGroup?: string;

  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsIn(PRODUCT_PHASES)
  productPhase?: string;

  @IsOptional()
  @IsString()
  productName?: string;

  /** Bảng khách × hàng: mở rộng 1 hàng cấp 1 (khách cha) → chỉ trả hàng con của khách đó. */
  @IsOptional()
  @IsString()
  expand?: string;

  /** Trang Xuất Data: trả toàn bộ hàng con để tải CSV. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  full?: boolean;

  /** Trang ĐLCL Lermao: các cột đại lý đang chọn ("Collums ĐLCL"); trống = tất cả. */
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  distributorIds?: number[];
}

// ── Cấu hình ──────────────────────────────────────────────────────────────

export class AnalyticsStrategicProgramUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  // null = không lọc theo nhóm khách
  @IsOptional()
  @IsString()
  customerGroupName?: string | null;

  @IsOptional()
  @IsString()
  productType?: string | null;

  @IsOptional()
  @IsString()
  brand?: string | null;
}

export class AnalyticsStrategicDistributorDto {
  @IsString()
  @IsNotEmpty()
  programCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  customerCodes!: string[];

  @IsOptional()
  @IsBoolean()
  matchAll?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class AnalyticsStrategicDistributorUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  customerCodes?: string[];

  @IsOptional()
  @IsBoolean()
  matchAll?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class AnalyticsStrategicDistributorListDto {
  @IsOptional()
  @IsString()
  program?: string;
}
