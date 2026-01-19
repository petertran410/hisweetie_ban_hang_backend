import { IsOptional, IsInt, IsArray, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class ProductionQueryDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(Number);
    }
    return Array.isArray(value) ? value.map(Number) : [Number(value)];
  })
  branchIds?: number[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(Number);
    }
    return Array.isArray(value) ? value.map(Number) : [Number(value)];
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
