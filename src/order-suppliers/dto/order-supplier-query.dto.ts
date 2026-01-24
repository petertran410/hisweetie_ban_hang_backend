import { IsOptional, IsInt, IsString } from 'class-validator';
import { Type } from 'class-transformer';

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
  @Type(() => Number)
  @IsInt()
  status?: number;

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
