import {
  IsNumber,
  IsString,
  IsOptional,
  IsDate,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePurchaseOrderItemDto {
  @IsNumber()
  @Type(() => Number)
  productId: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice: number;
}

export class CreatePurchaseOrderDto {
  @IsNumber()
  @Type(() => Number)
  supplierId: number;

  @IsDate()
  @Type(() => Date)
  purchaseDate: Date;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  shippingFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  otherFees?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  paidAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items: CreatePurchaseOrderItemDto[];
}

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  purchaseDate?: Date;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  shippingFee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  otherFees?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  paidAmount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class PurchaseOrderQueryDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsString()
  paymentStatus?: string;
}
