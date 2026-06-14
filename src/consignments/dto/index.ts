import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsIn,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class ConsignmentDeliveryDto {
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

export class ConsignmentItemDto {
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
  conditionType?: string;

  @IsString()
  @IsOptional()
  manufactureDate?: string;
}

export class CreateConsignmentDto {
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
  consignDate?: string;

  @IsNumber()
  @IsOptional()
  discountAmount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

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
  consignStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsignmentItemDto)
  items: ConsignmentItemDto[];

  @ValidateNested()
  @Type(() => ConsignmentDeliveryDto)
  @IsOptional()
  delivery?: ConsignmentDeliveryDto;
}

export class UpdateConsignmentDto {
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
  consignDate?: string;

  @IsNumber()
  @IsOptional()
  discountAmount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

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
  consignStatus?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsignmentItemDto)
  @IsOptional()
  items?: ConsignmentItemDto[];

  @ValidateNested()
  @Type(() => ConsignmentDeliveryDto)
  @IsOptional()
  delivery?: ConsignmentDeliveryDto;
}

/**
 * Chuyển trạng thái xử lý kho (B2): packed | loading | delivered.
 * Trừ kho 1 lần khi lần đầu sang `packed`.
 */
export class UpdateWarehouseStatusDto {
  @IsString()
  @IsIn(['packed', 'loading', 'delivered'])
  warehouseStatus: string;
}

export class CancelConsignmentDto {
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ConsignmentQueryDto {
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
  @Type(() => Number)
  @IsInt()
  soldById?: number;

  @IsOptional()
  @IsString()
  @IsIn([
    'consignDate',
    'createdAt',
    'updatedAt',
    'grandTotal',
    'totalAmount',
    'status',
  ])
  orderBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: string;
}

/**
 * DTO xuất hóa đơn từ phiếu ký gửi (B3) — mirror CreateInvoiceFromOrderDto.
 */
export class CreateInvoiceFromConsignmentDto {
  @IsNumber()
  @IsOptional()
  additionalPayment?: number;

  @IsOptional()
  @IsArray()
  payments?: Array<{ method: string; amount: number }>;

  @IsOptional()
  @IsNumber()
  soldById?: number;

  @IsArray()
  @IsOptional()
  items?: {
    productId: number;
    productCode: string;
    productName: string;
    quantity: number;
    price: number;
    discount: number;
    discountRatio: number;
    totalPrice: number;
    note?: string;
    conditionType?: string;
  }[];
}
