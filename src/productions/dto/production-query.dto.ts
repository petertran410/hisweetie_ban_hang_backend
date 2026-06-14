import { IsOptional, IsInt, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class ProductionQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  branchIds?: number[];

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  status?: number[];

  @IsOptional()
  @IsString()
  fromManufacturedDate?: string;

  @IsOptional()
  @IsString()
  toManufacturedDate?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number = 15;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number = 0;

  @IsOptional()
  @IsString()
  search?: string;
}
