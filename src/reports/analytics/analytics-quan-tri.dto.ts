import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ANALYTICS_AXES, AnalyticsAxis } from '../dto';

// Bộ lọc báo cáo Phân tích › Quản Trị (thay các slicer của report Power BI
// "Báo Cáo Quản Trị"). Mỗi trang chỉ gửi những slicer nó có.

/** view_by[mode] của Quản Trị: thêm Lợi Nhuận / % Lợi Nhuận (page_report = BOD). */
export const QT_METRICS = [
  'amount',
  'orders',
  'quantity',
  'customers',
  'profit',
  'margin',
] as const;
export type QtMetric = (typeof QT_METRICS)[number];

/** Bookmark của trang Lợi Nhuận. */
export const QT_PROFIT_VIEWS = [
  'team', // Nhóm Bán: Báo cáo kết quả kinh doanh + tỷ trọng nhóm bán
  'customer', // Khách Hàng Key
  'product', // Hàng Hóa + cây lợi nhuận + BC Chi Tiết Hàng Hóa
  'customerDetail', // BC Chi Tiết Khách Hàng
] as const;
export type QtProfitView = (typeof QT_PROFIT_VIEWS)[number];

export const QT_EXCLUSION_KINDS = ['customer', 'seller'] as const;
export type QtExclusionKind = (typeof QT_EXCLUSION_KINDS)[number];

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

export class QtQueryDto {
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

  @IsOptional()
  @IsIn(ANALYTICS_AXES)
  axis?: AnalyticsAxis;

  @IsOptional()
  @IsIn(QT_METRICS)
  metric?: QtMetric;

  /** Nhóm bán (dim_user[group_sale_name]): id team; 0 = "6.Khác" (nhân viên ngoài team). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  saleTeamId?: number;

  /** dim_customers[customer_group] (= loại khách: Khách buôn / chuỗi / lẻ). */
  @IsOptional()
  @IsString()
  customerType?: string;

  @IsOptional()
  @IsString()
  parentName?: string;

  /** dim_sale_channel[group_source]. */
  @IsOptional()
  @IsString()
  groupSource?: string;

  /** dim_product[product_group_2026]. */
  @IsOptional()
  @IsString()
  productGroup?: string;

  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  category?: string;

  /** dim_product[origin] (= products.middle_name). */
  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  /** dim_product[name] — chọn theo mã hàng. */
  @IsOptional()
  @IsString()
  productCode?: string;
}

export class QtProfitQueryDto extends QtQueryDto {
  @IsOptional()
  @IsIn(QT_PROFIT_VIEWS)
  view?: QtProfitView;
}

// ===== Cấu hình: khách / nhân viên không tính vào báo cáo =====

export class QtExclusionDto {
  @IsIn(QT_EXCLUSION_KINDS)
  kind!: QtExclusionKind;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QtExclusionUpdateDto {
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
