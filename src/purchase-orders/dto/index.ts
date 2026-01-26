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
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;

  @IsString()
  @IsOptional()
  search?: string;

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
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  purchaseById?: number;

  @IsString()
  @IsOptional()
  createdDateFrom?: string;

  @IsString()
  @IsOptional()
  createdDateTo?: string;
}

export class CreatePurchaseOrderFromOrderSupplierDto {
  additionalPayment?: number;
}
