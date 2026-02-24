import { IsOptional, IsInt, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class AllPackingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsString()
  @IsIn(['all', 'giao-hang', 'dong-hang', 'loading'])
  type?: string;

  @IsOptional()
  @IsString()
  search?: string;

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
