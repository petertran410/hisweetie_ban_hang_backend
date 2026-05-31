import { IsOptional, IsInt, IsString, IsIn, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class AllPackingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : value !== undefined
          ? [Number(value)]
          : undefined,
  )
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @IsString()
  @IsIn(['all', 'giao-hang', 'dong-hang', 'loading'])
  type?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  invoiceSearch?: string;

  @IsOptional()
  @IsString()
  customerSearch?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;
}
