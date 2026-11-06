import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

// Query / body cho Phân tích › Chuyển Kho + Thu Mua (dataset_purchasing của Power BI).
// Mảng truyền dạng key lặp lại (?brands=A&brands=B); 1 giá trị thì nhận chuỗi.

/** Giá trị đại diện cho ô trống (BLANK của Power BI) trong bộ lọc. */
export const MUA_HANG_BLANK = '__blank__';

const rawOf = (p: {
  value: unknown;
  obj?: Record<string, unknown>;
  key?: string;
}) => (p.obj && p.key && p.key in p.obj ? p.obj[p.key] : p.value);

const toStrArray = (p: {
  value: unknown;
  obj?: Record<string, unknown>;
  key?: string;
}) => {
  const v = rawOf(p);
  if (v === undefined || v === null || v === '') return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x)).filter((x) => x !== '');
};

const toIntArray = (p: {
  value: unknown;
  obj?: Record<string, unknown>;
  key?: string;
}) => {
  const v = rawOf(p);
  if (v === undefined || v === null || v === '') return undefined;
  const arr: unknown[] = Array.isArray(v)
    ? v
    : typeof v === 'string' || typeof v === 'number'
      ? String(v).split(',')
      : [];
  return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n));
};

/** Slicer sản phẩm / kho dùng chung các trang (dim_product, dim_branch). */
export class MuaHangFilterDto {
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  branches?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  productTypes?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  brands?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  visualGroups?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  groups2026?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  categories?: string[];

  /** Slicer dim_product[name] → lọc theo mã hàng. */
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  productCodes?: string[];
}

/** Trang có số bán / demand theo ngày: thêm năm + tháng (dim_date). */
export class MuaHangPeriodQueryDto extends MuaHangFilterDto {
  // Bỏ trống = mọi năm (slicer Power BI không chọn gì).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2022)
  @Max(2100)
  year?: number;

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  months?: number[];
}

export const MUA_HANG_TREND_LEVELS = ['year', 'month', 'day'] as const;
export type MuaHangTrendLevel = (typeof MUA_HANG_TREND_LEVELS)[number];

export class MuaHangSalesQueryDto extends MuaHangPeriodQueryDto {
  // Cấp trục của biểu đồ "Tình Hình Bán Hàng" (phân cấp Năm › Tháng › Ngày).
  @IsOptional()
  @IsIn(MUA_HANG_TREND_LEVELS)
  trendLevel?: MuaHangTrendLevel;
}

export class MuaHangDemandQueryDto extends MuaHangPeriodQueryDto {
  // Slicer fact_demand[customer_name] → lọc theo id khách.
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  customerIds?: number[];
}

// ===== Cấu hình =====

export class MuaHangConfigListQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class MuaHangCodeMergeDto {
  @IsString()
  @IsNotEmpty()
  fromCode!: string;

  @IsString()
  @IsNotEmpty()
  toCode!: string;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class MuaHangCodeMergeUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  toCode?: string;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class MuaHangExcludedSellerDto {
  @Type(() => Number)
  @IsInt()
  userId!: number;
}

export class MuaHangPurchaseProductUpdateDto {
  @IsOptional()
  @IsString()
  manufactory?: string | null;

  @IsOptional()
  @IsString()
  spec?: string | null;

  @IsOptional()
  @IsString()
  supplyType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minOrderBox?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minStockHn?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minStockSg?: number | null;

  @IsOptional()
  @IsString()
  packDetail?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  convertQuantity?: number | null;

  @IsOptional()
  @IsString()
  subCateLv1?: string | null;

  @IsOptional()
  @IsString()
  subCateLv2?: string | null;
}

export class MuaHangPurchaseProductDto extends MuaHangPurchaseProductUpdateDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;
}

export const REBATE_TYPES = ['value', 'percent', 'both'] as const;

/** Các trường số / loại của rebate (dùng chung cho thêm & sửa). */
class MuaHangRebateValues {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  targetCny?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  targetVnd?: number | null;

  @IsOptional()
  @IsIn(REBATE_TYPES)
  rebateType?: (typeof REBATE_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  mainValue?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subValue?: number | null;
}

export class MuaHangRebateDto extends MuaHangRebateValues {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  applyYear!: number;

  @IsString()
  @IsNotEmpty()
  manufactory!: string;

  @IsString()
  @IsNotEmpty()
  rebateName!: string;
}

export class MuaHangRebateUpdateDto extends MuaHangRebateValues {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  applyYear?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  manufactory?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rebateName?: string;
}
