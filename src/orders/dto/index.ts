import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OrderItemDto {
  @IsInt()
  productId: number;

  @IsInt()
  quantity: number;

  @IsInt()
  unitPrice: number;
}

export class CreateOrderDto {
  @IsInt()
  @IsOptional()
  customerId?: number;

  @IsDateString()
  @IsOptional()
  orderDate?: string;

  @IsInt()
  @IsOptional()
  discountAmount?: number;

  @IsInt()
  @IsOptional()
  depositAmount?: number;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  orderStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}

export class UpdateOrderDto {
  @IsInt()
  @IsOptional()
  customerId?: number;

  @IsDateString()
  @IsOptional()
  orderDate?: string;

  @IsInt()
  @IsOptional()
  discountAmount?: number;

  @IsInt()
  @IsOptional()
  depositAmount?: number;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  orderStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @IsOptional()
  items?: OrderItemDto[];
}

export class OrderQueryDto {
  @IsInt()
  @IsOptional()
  page?: number;

  @IsInt()
  @IsOptional()
  limit?: number;

  @IsString()
  @IsOptional()
  search?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsInt()
  @IsOptional()
  customerId?: number;
}

export class CreateOrderPaymentDto {
  @IsInt()
  orderId: number;

  @IsDateString()
  @IsOptional()
  paymentDate?: string;

  @IsInt()
  amount: number;

  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
