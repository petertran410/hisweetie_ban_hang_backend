import { IsOptional, IsInt, IsString, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class OrderSupplierQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  supplierId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    const arr = Array.isArray(value) ? value : [value];
    return arr.map(Number);
  })
  @IsArray()
  @IsInt({ each: true })
  status?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsString()
  createdDateFrom?: string;

  @IsOptional()
  @IsString()
  createdDateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;
}
