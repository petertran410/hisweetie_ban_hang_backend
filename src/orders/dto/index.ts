import {
  IsNumber,
  IsString,
  IsOptional,
  IsDate,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class CreateOrderItemDto {
  @IsNumber()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  unitPrice: number;
}

export class CreateOrderDto {
  @IsOptional()
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  orderDate?: Date;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  depositAmount?: number;

  @IsOptional()
  @IsString()
  orderStatus?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}

export class UpdateOrderDto extends CreateOrderDto {}

export class OrderQueryDto {
  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @IsString()
  orderStatus?: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;
}
