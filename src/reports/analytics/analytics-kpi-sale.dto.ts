import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Query & body cho Phân tích › KPI Sale (route reports/analytics/kpi-sale).

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

/** "a,b" hoặc ?x=a&x=b → ['a','b'] (bỏ phần tử rỗng). */
const toStrArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return arr
    .filter((v): v is string | number =>
      ['string', 'number'].includes(typeof v),
    )
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Bộ lọc chung: Năm (dim_month[year]), Tháng (dim_month[vie_month]), Nhân viên (dim_user). */
export class KpiSaleQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  months?: number[];

  /** Mã nhân viên (phần trước @ của email) — dim_user[user_key]. */
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  users?: string[];
}

/** Trang Theo Ngày: thêm Ngày mua, Người bán, Nhóm hàng, Mã hoá đơn, phân trang bảng chi tiết. */
export class KpiSaleDailyQueryDto extends KpiSaleQueryDto {
  @IsOptional()
  @Matches(ISO_DATE)
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  to?: string;

  /** users.id của người bán (invoice[sold_by_name]). 0 = không có người bán. */
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  sellers?: number[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  groups?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  invoiceCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(500)
  pageSize?: number;
}

/** Trang Lên Đơn Hộ: thêm Người PIC (dim_customers[sale_pic]). */
export class KpiSaleOrderQueryDto extends KpiSaleQueryDto {
  /** Tên nhóm sale_pic; "__none__" = khách không thuộc nhóm sale nào. */
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  salePics?: string[];

  /** Bảng khách: tìm theo mã / tên khách, phân trang. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(500)
  pageSize?: number;
}

// ===== Cấu hình =====

export class KpiConfigListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}

export class KpiRevenueTargetDto {
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  saleCode!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kpiValue!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basicSalary?: number;
}

export class KpiProductTargetDto {
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  saleCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  productGroup!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kpiValue!: number;
}

export class KpiRepRuleDto {
  @Type(() => Number)
  @IsInt()
  priority!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  salePic!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  saleCode!: string;

  @IsOptional()
  @Matches(ISO_DATE)
  validFrom?: string | null;

  @IsOptional()
  @Matches(ISO_DATE)
  validTo?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class KpiIncomeRuleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  saleCode!: string;

  @IsArray()
  @IsString({ each: true })
  customerTypes!: string[];

  @IsArray()
  @IsString({ each: true })
  productTypes!: string[];

  @IsArray()
  @IsString({ each: true })
  productGroups!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class KpiProductMapDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fromCode!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  toCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class KpiRevenueTargetUpdateDto extends PartialType(
  KpiRevenueTargetDto,
) {}
export class KpiProductTargetUpdateDto extends PartialType(
  KpiProductTargetDto,
) {}
export class KpiRepRuleUpdateDto extends PartialType(KpiRepRuleDto) {}
export class KpiIncomeRuleUpdateDto extends PartialType(KpiIncomeRuleDto) {}
export class KpiProductMapUpdateDto extends PartialType(KpiProductMapDto) {}
