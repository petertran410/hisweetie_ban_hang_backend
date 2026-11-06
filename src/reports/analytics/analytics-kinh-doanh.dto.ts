import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AnalyticsBusinessQueryDto } from '../dto';

const toStrArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return [];
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr
    .map((v) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '',
    )
    .filter(Boolean);
};

// Bộ lọc các trang Kinh Doanh (ngoài Tổng Quan). Kế thừa bộ lọc chung của
// Tổng Quan (năm, tháng, nhóm bán, nhóm khách, nhóm hàng, khách cha, vùng) và
// thêm các slicer riêng của từng trang Power BI.

export const KD_METRICS = [
  'amount',
  'orders',
  'quantity',
  'customers',
] as const;
export type KdMetric = (typeof KD_METRICS)[number];

export const KD_SPECIAL_GROUPS = [
  'ĐLCL Boduo',
  'ĐLCL Lermao',
  'ĐLCL Phượng Hoàng',
  'VIP Công Ty',
  'KEY Sale 1',
  'KEY Sale 2',
  'KEY Sale 3',
  'KEY Sale 4',
  'KEY Sale 5',
  'Hiển Setup',
  'chị Bé Setup',
] as const;

export const KD_DASHBOARD_VIEWS = ['week', 'lastWeek', 'month'] as const;
export type KdDashboardView = (typeof KD_DASHBOARD_VIEWS)[number];

export const KD_CUSTOMER_SECTIONS = [
  'overview',
  'region',
  'detail',
  'repeat',
  'churn',
  'demand',
  'lermao',
  'mutLermao',
  'boduo',
  'phuongHoang',
] as const;
export type KdCustomerSection = (typeof KD_CUSTOMER_SECTIONS)[number];

/** Chiều được phép làm dòng của pivot. */
export const KD_PIVOT_DIMS = [
  'region',
  'province',
  'parent_name',
  'customer_name',
  'customer_type',
  'sale_admin_pic',
  'team',
  'seller',
  'product_name',
  'product_type',
  'brand',
  'category',
  'group2026',
  'visual_group',
] as const;

/** Phạm vi cố định của từng biểu đồ (filter cấp visual / bookmark của Power BI). */
export const KD_SCOPES = [
  'all',
  'keyLermao', // dim_customers[is_customer_key_lermao] = 1
  'lermaoKey', // khách ĐLCL Lermao × hàng thương hiệu Lermao
  'mutLermaoKey', // khách ĐLCL Lermao × Mứt Lermao
  'boduoKey', // khách ĐL BODUO × hàng Boduo
  'phKey', // khách ĐL Trà Phượng Hoàng × hàng Phượng Hoàng
  'vip', // Khách VIP Cty (is_customer_key)
  'lermaoPh', // hàng thương hiệu Lermao + Phượng Hoàng
  'toppingLermao', // hàng thương hiệu Lermao (Topping Lermao theo vùng)
] as const;
export type KdScope = (typeof KD_SCOPES)[number];

export class KdQueryDto extends AnalyticsBusinessQueryDto {
  @IsOptional()
  @IsIn(KD_METRICS)
  metric?: KdMetric;

  @IsOptional()
  @IsString()
  customerType?: string;

  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsOptional()
  @IsIn(KD_SPECIAL_GROUPS)
  specialGroup?: string;

  @IsOptional()
  @IsIn(KD_SCOPES)
  scope?: KdScope;

  /** Ngày "hôm nay" dùng cho các số tuần này / tháng này (mặc định hôm nay). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  refDate?: string;
}

export class KdDashboardQueryDto extends KdQueryDto {
  @IsIn(KD_DASHBOARD_VIEWS)
  view!: KdDashboardView;
}

export class KdCustomerQueryDto extends KdQueryDto {
  @IsIn(KD_CUSTOMER_SECTIONS)
  section!: KdCustomerSection;

  /** Slicer "Tên Chuỗi" của bảng Demand (mã khách). */
  @IsOptional()
  @IsString()
  demandCustomer?: string;

  /** Thùng / Gói cho bảng Demand (view_bulk_base). */
  @IsOptional()
  @IsIn(['base', 'bulk'])
  unit?: 'base' | 'bulk';
}

export class KdPivotQueryDto extends KdQueryDto {
  @Transform(toStrArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(KD_PIVOT_DIMS, { each: true })
  rows!: string[];

  /** Giá trị các cấp trên của nút đang mở (rỗng = cấp 1). '__null__' = trống. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined || value === null
      ? undefined
      : (Array.isArray(value) ? value : [value]).map((v) => String(v)),
  )
  @IsArray()
  @IsString({ each: true })
  path?: string[];

  @IsOptional()
  @IsIn(['month', 'week', 'none'])
  cols?: 'month' | 'week' | 'none';

  @IsOptional()
  @IsIn(['mom', 'wow', 'none'])
  growth?: 'mom' | 'wow' | 'none';

  /** Luôn tính số cấp dòng hàng (Revenue Detail / Total Orders in Detail). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  detail?: boolean;
}

export class KdChurnQueryDto extends KdQueryDto {
  @IsOptional()
  @IsIn(['1.Khách Churn', '2.Khách bỏ mã', '3.Bình thường', 'all'])
  churnGroup?: string;
}

// ===== Cấu hình =====

export class KdVisualTargetDto {
  @IsString()
  @IsNotEmpty()
  visualProductGroup!: string;

  @Type(() => Number)
  @IsInt()
  @Min(2022)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @Type(() => Number)
  @Min(0)
  kpiValue!: number;
}

export class KdVisualTargetUpdateDto {
  @Type(() => Number)
  @Min(0)
  kpiValue!: number;
}

export class KdCustomerKeyDto {
  @IsString()
  @IsNotEmpty()
  customerCode!: string;

  @IsOptional()
  @IsBoolean()
  isVip?: boolean;
}

export class KdCustomerKeyUpdateDto {
  @IsBoolean()
  isVip!: boolean;
}

export class KdDlclColumnDto {
  @IsString()
  @IsNotEmpty()
  label!: string;

  @Transform(toStrArray)
  @IsArray()
  @IsString({ each: true })
  customerCodes!: string[];

  @Type(() => Number)
  @IsInt()
  sortOrder!: number;
}

export class KdDlclColumnUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  label?: string;

  @IsOptional()
  @Transform(toStrArray)
  @IsArray()
  @IsString({ each: true })
  customerCodes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class KdJamFlavorDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;

  @IsIn(['Lermao', 'Boduo'])
  brand!: string;

  @IsString()
  @IsNotEmpty()
  jamFlavor!: string;
}

export class KdJamFlavorUpdateDto {
  @IsOptional()
  @IsIn(['Lermao', 'Boduo'])
  brand?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  jamFlavor?: string;
}
