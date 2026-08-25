import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Min,
  ValidateIf,
} from 'class-validator';

export const CONFIG_SCOPES = ['GLOBAL', 'CATEGORY', 'SUPPLIER', 'SKU'] as const;
export type ConfigScopeDto = (typeof CONFIG_SCOPES)[number];

export class PlanningConfigValuesDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  safetyDays?: number | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  coverageDays?: number | null;
}

export class CreatePlanningConfigDto extends PlanningConfigValuesDto {
  @IsIn(CONFIG_SCOPES)
  scopeType!: ConfigScopeDto;

  @ValidateIf((dto) => dto.scopeType !== 'GLOBAL')
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  scopeId?: number | null;
}

export class UpdatePlanningConfigDto extends PlanningConfigValuesDto {}

export class ResolvedPlanningConfigQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  skuId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  supplierId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  categoryId?: number;
}
