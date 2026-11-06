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

// Trục thời gian của biểu đồ theo kỳ (field parameter auto_period).
export const ANALYTICS_AXES = ['month', 'day', 'weekday'] as const;
export type AnalyticsAxis = (typeof ANALYTICS_AXES)[number];

const toIntArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? String(value).split(',')
      : [];
  return arr.map((v) => Number(v)).filter((n) => Number.isInteger(n));
};

export class AnalyticsBusinessQueryDto {
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

  // Các bộ lọc dưới đây chọn 1 giá trị như slicer của Power BI.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  saleTeamId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerGroupId?: number;

  @IsOptional()
  @IsString()
  productGroup?: string;

  @IsOptional()
  @IsString()
  visualProductGroup?: string;

  @IsOptional()
  @IsString()
  parentName?: string;

  @IsOptional()
  @IsString()
  region?: string;
}

// ===== Cấu hình =====

export const PARENT_RULE_MATCH_TYPES = ['code', 'name_contains'] as const;

export class AnalyticsParentRuleDto {
  @IsIn(PARENT_RULE_MATCH_TYPES)
  matchType!: (typeof PARENT_RULE_MATCH_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  pattern!: string;

  @IsString()
  @IsNotEmpty()
  parentName!: string;

  @Type(() => Number)
  @IsInt()
  priority!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AnalyticsParentRuleUpdateDto {
  @IsOptional()
  @IsIn(PARENT_RULE_MATCH_TYPES)
  matchType?: (typeof PARENT_RULE_MATCH_TYPES)[number];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  pattern?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  parentName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AnalyticsSaleTeamDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsBoolean()
  isSale?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class AnalyticsSaleTeamUpdateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isSale?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class AnalyticsTeamMemberDto {
  @Type(() => Number)
  @IsInt()
  userId!: number;

  @Type(() => Number)
  @IsInt()
  teamId!: number;
}

export class AnalyticsProductGroupDto {
  @IsString()
  @IsNotEmpty()
  productCode!: string;

  @IsString()
  @IsNotEmpty()
  groupName!: string;
}

export class AnalyticsProductGroupUpdateDto {
  @IsString()
  @IsNotEmpty()
  groupName!: string;
}

export class AnalyticsConfigListQueryDto {
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

export class AnalyticsMemberUpdateDto {
  // null / bỏ trống = bỏ nhân viên khỏi team
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  teamId?: number | null;
}

export class AnalyticsPreviewParentQueryDto {
  @IsString()
  @IsNotEmpty()
  search!: string;
}
