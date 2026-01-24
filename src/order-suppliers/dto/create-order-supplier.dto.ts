import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class CreateOrderSupplierItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateOrderSupplierDto {
  @IsInt()
  supplierId: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsInt()
  @IsOptional()
  userId?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  status?: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsBoolean()
  @IsOptional()
  toComplete?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderSupplierItemDto)
  items: CreateOrderSupplierItemDto[];
}
