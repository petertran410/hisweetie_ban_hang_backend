import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

// DTO của báo cáo Phân tích › Định Kì + Hằng Tuần.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

const toStringArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('|')
      : [];
  return arr.map((v) => String(v).trim()).filter((s) => s.length > 0);
};

/** Ngày mốc thay cho TODAY() của Power BI (mặc định hôm nay) — xem lại tuần / tháng cũ. */
export class DinhKiDateQueryDto {
  @IsOptional()
  @Matches(ISO_DATE)
  date?: string;
}

/** Trang Chi Tiết: ngày mốc + các slicer có tác dụng (Nhóm Bán, Nhóm Hàng, Tên Khách Key). */
export class DinhKiDetailQueryDto extends DinhKiDateQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  saleTeamId?: number;

  @IsOptional()
  @IsString()
  productGroup?: string;

  @IsOptional()
  @IsString()
  parentName?: string;
}

/** Trang Đối Thủ: slicer Năm + Tháng. */
export class DinhKiBrandQueryDto {
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
}

/** Hằng Tuần: Năm (filter report) + slicer Tháng, Tuần, Nhóm Bán, Người Bán. */
export class HangTuanQueryDto {
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

  // Ngày thứ 2 đầu tuần, nối bằng "|".
  @IsOptional()
  @Transform(toStringArray)
  @Matches(ISO_DATE, { each: true })
  weeks?: string[];

  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  saleTeamIds?: number[];

  // Tên nhóm "Người Bán", nối bằng "|".
  @IsOptional()
  @Transform(toStringArray)
  @IsString({ each: true })
  sellerGroups?: string[];
}

// ===== Cấu hình =====

export const DK_TARGET_KINDS = ['group2026', 'visual'] as const;
export type DkTargetKind = (typeof DK_TARGET_KINDS)[number];

export class DkGroupTargetListQueryDto {
  @IsOptional()
  @IsIn(DK_TARGET_KINDS)
  kind?: DkTargetKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}

export class DkGroupTargetDto {
  @IsIn(DK_TARGET_KINDS)
  kind!: DkTargetKind;

  @IsString()
  @IsNotEmpty()
  groupName!: string;

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
  @IsNumber()
  @Min(0)
  kpiValue!: number;
}

export class DkGroupTargetUpdateDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kpiValue!: number;
}

export const DK_JAM_BRANDS = ['Lermao', 'Boduo'] as const;

export class DkJamFlavorDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;

  @IsString()
  @IsNotEmpty()
  jamFlavor!: string;

  @IsIn(DK_JAM_BRANDS)
  brand!: (typeof DK_JAM_BRANDS)[number];
}

export class DkJamFlavorUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  jamFlavor?: string;

  @IsOptional()
  @IsIn(DK_JAM_BRANDS)
  brand?: (typeof DK_JAM_BRANDS)[number];
}

export class DkJamFlavorListQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}

export class DkWeeklySellerDto {
  @IsString()
  @IsNotEmpty()
  sellerGroup!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}
