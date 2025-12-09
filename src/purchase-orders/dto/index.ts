import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseOrderItemDto {
  @IsInt()
  productId: number;

  @IsInt()
  quantity: number;

  @IsInt()
  unitPrice: number;
}

export class CreatePurchaseOrderDto {
  @IsInt()
  supplierId: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsInt()
  @IsOptional()
  shippingFee?: number;

  @IsInt()
  @IsOptional()
  otherFees?: number;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];
}

export class UpdatePurchaseOrderDto {
  @IsInt()
  @IsOptional()
  supplierId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsInt()
  @IsOptional()
  shippingFee?: number;

  @IsInt()
  @IsOptional()
  otherFees?: number;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  @IsOptional()
  items?: PurchaseOrderItemDto[];
}

export class PurchaseOrderQueryDto {
  @IsInt()
  @IsOptional()
  page?: number;

  @IsInt()
  @IsOptional()
  limit?: number;

  @IsString()
  @IsOptional()
  search?: string;

  @IsInt()
  @IsOptional()
  supplierId?: number;

  @IsString()
  @IsOptional()
  status?: string;
}
