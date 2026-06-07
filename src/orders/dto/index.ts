import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsDecimal,
  IsIn,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class DeliveryInfoDto {
  @IsString()
  @IsOptional()
  receiver?: string;

  @IsString()
  @IsOptional()
  contactNumber?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  locationName?: string;

  @IsString()
  @IsOptional()
  wardName?: string;

  @IsNumber()
  @IsOptional()
  weight?: number;

  @IsString()
  @IsOptional()
  weightUnit?: string;

  @IsNumber()
  @IsOptional()
  length?: number;

  @IsNumber()
  @IsOptional()
  width?: number;

  @IsNumber()
  @IsOptional()
  height?: number;

  @IsString()
  @IsOptional()
  noteForDriver?: string;
}

export class OrderItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  unitPrice: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsOptional()
  @IsIn(['normal', 'damaged', 'near_expiry'])
  conditionType?: string; // "normal" | "damaged" | "near_expiry"

  @IsString()
  @IsOptional()
  serialNumbers?: string;
}

export class CreateOrderDto {
  @IsInt()
  customerId: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsInt()
  @IsOptional()
  priceBookId?: number;

  @IsDateString()
  @IsOptional()
  orderDate?: string;

  @IsNumber()
  @IsOptional()
  discountAmount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsNumber()
  @IsOptional()
  depositAmount?: number;

  @IsNumber()
  @IsOptional()
  saleChannelId?: number;

  @IsNumber()
  @IsOptional()
  soldById?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  orderStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => DeliveryInfoDto)
  @IsOptional()
  delivery?: DeliveryInfoDto;
}

export class UpdateOrderDto {
  @IsInt()
  @IsOptional()
  customerId?: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsInt()
  @IsOptional()
  priceBookId?: number;

  @IsDateString()
  @IsOptional()
  orderDate?: string;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsNumber()
  @IsOptional()
  soldById?: number;

  @IsNumber()
  @IsOptional()
  discountAmount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  depositAmount?: number;

  @IsNumber()
  @IsOptional()
  saleChannelId?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  orderStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @IsOptional()
  items?: OrderItemDto[];

  @ValidateNested()
  @Type(() => DeliveryInfoDto)
  @IsOptional()
  delivery?: DeliveryInfoDto;
}

export class OrderQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

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

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',');
    return [];
  })
  @IsArray()
  statuses?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [];
  })
  @IsArray()
  branchIds?: number[];

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsString()
  fromCreatedDate?: string;

  @IsOptional()
  @IsString()
  toCreatedDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  soldById?: number;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : value !== undefined
          ? [Number(value)]
          : undefined,
  )
  @IsArray()
  @IsInt({ each: true })
  createdByIds?: number[];

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : value !== undefined
          ? [Number(value)]
          : undefined,
  )
  @IsArray()
  @IsInt({ each: true })
  soldByIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  saleChannelId?: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [];
  })
  @IsArray()
  bankAccountIds?: number[];

  @IsOptional()
  @IsString()
  @IsIn([
    'orderDate',
    'createdAt',
    'updatedAt',
    'grandTotal',
    'paidAmount',
    'debtAmount',
    'totalAmount',
    'status',
  ])
  orderBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: string;
}

export class CreateOrderPaymentDto {
  @IsInt()
  @Type(() => Number)
  orderId: number;

  @IsDateString()
  @IsOptional()
  paymentDate?: string;

  @IsNumber()
  amount: number;

  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  sepayTransactionId?: string;

  @IsString()
  @IsOptional()
  sepayReferenceCode?: string;
}

export class ProductPriceHistoryDto {
  @IsInt()
  @Type(() => Number)
  customerId: number;

  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  @IsIn(['order', 'invoice'])
  type?: 'order' | 'invoice';
}
