import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseOrderItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsString()
  @IsOptional()
  description?: string;
}

export class PurchaseOrderSurchargeDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsNumber()
  @IsOptional()
  value?: number;

  @IsNumber()
  @IsOptional()
  valueRatio?: number;

  @IsBoolean()
  @IsOptional()
  isSupplierExpense?: boolean;

  @IsInt()
  @IsOptional()
  type?: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  orderSupplierId?: number;

  @IsInt()
  supplierId: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderSurchargeDto)
  @IsOptional()
  surcharges?: PurchaseOrderSurchargeDto[];
}

export class UpdatePurchaseOrderDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  supplierId?: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  @IsOptional()
  items?: PurchaseOrderItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderSurchargeDto)
  @IsOptional()
  surcharges?: PurchaseOrderSurchargeDto[];
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}

export class CreatePurchaseOrderFromOrderSupplierItemDto {
  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  totalPrice: number;

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreatePurchaseOrderFromOrderSupplierPaymentDto {
  @IsString()
  method: string;

  @IsNumber()
  amount: number;

  @IsInt()
  @IsOptional()
  accountId?: number;
}

export class CreatePurchaseOrderFromOrderSupplierDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsNumber()
  @IsOptional()
  additionalPayment?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderFromOrderSupplierPaymentDto)
  @IsOptional()
  payments?: CreatePurchaseOrderFromOrderSupplierPaymentDto[];

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderFromOrderSupplierItemDto)
  @IsOptional()
  items?: CreatePurchaseOrderFromOrderSupplierItemDto[];
}

export * from './cancel-purchase-order.dto';
