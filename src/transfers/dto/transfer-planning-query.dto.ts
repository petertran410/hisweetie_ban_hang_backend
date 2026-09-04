import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class TransferPlanningQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return Array.isArray(value) ? value : [value];
  })
  parentNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return Array.isArray(value) ? value : [value];
  })
  middleNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return Array.isArray(value) ? value : [value];
  })
  childNames?: string[];

  @IsOptional()
  @IsIn(['COLD', 'NORMAL'])
  cargoType?: 'COLD' | 'NORMAL';

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(Number).filter((n) => !isNaN(n));
    }
    return Array.isArray(value) ? value.map(Number) : [Number(value)];
  })
  tradeMarkIds?: number[];

  @IsOptional()
  @IsIn(['ALL', 'NEED_TRANSFER', 'NO_TRANSFER', 'HAS_CONFIRMED_ORDERS'])
  quickFilter?: 'ALL' | 'NEED_TRANSFER' | 'NO_TRANSFER' | 'HAS_CONFIRMED_ORDERS';

  @IsOptional()
  @IsIn(['ALL', 'DARK_RED', 'RED', 'YELLOW', 'GREEN'])
  alertFilter?: 'ALL' | 'DARK_RED' | 'RED' | 'YELLOW' | 'GREEN';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit = 25;

  @IsOptional()
  @IsString()
  sortBy = 'suggestedQuantity';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDirection: 'asc' | 'desc' = 'desc';
}
