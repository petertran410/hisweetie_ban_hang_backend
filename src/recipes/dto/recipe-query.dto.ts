import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString } from 'class-validator';

export class RecipeQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').filter(Boolean);
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  ingredientFilters?: string[];

  @IsOptional()
  @IsIn(['SEMI_FINISHED', 'FINISHED_PRODUCT'])
  type?: 'SEMI_FINISHED' | 'FINISHED_PRODUCT';

  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  categoryId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number = 15;

  @IsOptional()
  @IsIn(['name', 'code', 'updatedAt', 'createdAt', 'totalCost'])
  orderBy?: 'name' | 'code' | 'updatedAt' | 'createdAt' | 'totalCost';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';
}

export class CalculateCostDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  priceBookId?: number;

  @IsOptional()
  @IsString()
  currencyCode?: string;
}
