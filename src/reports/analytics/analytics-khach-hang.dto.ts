import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ANALYTICS_AXES, type AnalyticsAxis } from '../dto';

// Query của báo cáo Phân tích › Khách Hàng (trang Tất Cả, VIP, Key Persale,
// New / Repeat / Churn Customer, Demand). Mỗi bộ lọc chọn 1 giá trị như slicer Power BI.

export const KH_METRICS = [
  'amount',
  'orders',
  'quantity',
  'customers',
] as const;
export type KhMetric = (typeof KH_METRICS)[number];

export const KH_LIST_KEYS = [
  'key_persale',
  'vip_layer2',
  'demand_maycha',
  'internal_customers',
] as const;
export type KhListKey = (typeof KH_LIST_KEYS)[number];

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

export class KhachHangQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2022)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  months?: number[];

  // Trục của biểu đồ "Tình hình mua hàng của khách" (field parameter auto_period).
  @IsOptional()
  @IsIn(ANALYTICS_AXES)
  axis?: AnalyticsAxis;

  // view_by (Tính toán bởi) — dùng để xếp hạng Top 10.
  @IsOptional()
  @IsIn(KH_METRICS)
  metric?: KhMetric;

  // ── Khách (dim_customers / dim_customer_group) ──
  @IsOptional()
  @IsString()
  customerType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerGroupId?: number;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  region?: string;

  // ── Hàng (dim_product) ──
  @IsOptional()
  @IsString()
  productGroup?: string; // product_group_2026

  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  productPhase?: string; // new_product_phase

  @IsOptional()
  @IsString()
  productCode?: string;
}

/** Trang VIP / Key Persale: thêm "Chọn Tuần" (số tuần WEEKNUM(…, 2) trong năm). */
export class KhachHangWeeklyQueryDto extends KhachHangQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(54)
  week?: number;
}

/** Trang Demand. */
export class KhachHangDemandQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2022)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  months?: number[];

  // view_bulk_base: base = Gói (đơn vị cơ bản), bulk = Thùng.
  @IsOptional()
  @IsIn(['base', 'bulk'])
  unit?: 'base' | 'bulk';

  @IsOptional()
  @IsString()
  customerCode?: string;
}

// ===== Cấu hình =====

export class KhCustomerListQueryDto {
  @IsIn(KH_LIST_KEYS)
  listKey!: KhListKey;
}

export class KhCustomerListItemDto {
  @IsIn(KH_LIST_KEYS)
  listKey!: KhListKey;

  @IsString()
  @IsNotEmpty()
  customerCode!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class KhSalePicDto {
  @IsString()
  @IsNotEmpty()
  groupName!: string;

  @IsOptional()
  @IsString()
  teamName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class KhSalePicUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  groupName?: string;

  @IsOptional()
  @IsString()
  teamName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class KhSaleRepRuleDto {
  @IsString()
  @IsNotEmpty()
  salePic!: string;

  @IsOptional()
  @IsString()
  customerType?: string | null;

  @IsOptional()
  @IsString()
  region?: string | null;

  @IsString()
  @IsNotEmpty()
  saleRep!: string;

  @Type(() => Number)
  @IsInt()
  priority!: number;
}

export class KhSaleRepRuleUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  salePic?: string;

  @IsOptional()
  @IsString()
  customerType?: string | null;

  @IsOptional()
  @IsString()
  region?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  saleRep?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;
}
