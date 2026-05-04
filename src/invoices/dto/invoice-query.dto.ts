import {
  IsOptional,
  IsInt,
  IsString,
  IsDateString,
  IsArray,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class InvoiceQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
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
  @IsArray()
  @Transform(({ value }) => {
    if (typeof value === 'string') return value.split(',').map(Number);
    if (Array.isArray(value)) return value.map(Number);
    return value;
  })
  customerIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  parentCustomerId?: number;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  statusIds?: number[];

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['none', 'pending', 'delivered'])
  deliveryStatus?: 'none' | 'pending' | 'delivered';

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  bankAccountIds?: number[];

  @IsOptional()
  @IsDateString()
  fromPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  toPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  fromCreatedDate?: string;

  @IsOptional()
  @IsDateString()
  toCreatedDate?: string;

  @IsOptional()
  @IsString()
  invoiceCodeSearch?: string;

  @IsOptional()
  @IsString()
  productSearch?: string;

  @IsOptional()
  @IsString()
  customerSearch?: string;

  @IsOptional()
  @IsString()
  orderBy?: string;

  @IsOptional()
  @IsString()
  orderDirection?: string;

  @IsOptional()
  @IsString()
  deliveryCodeSearch?: string;

  @IsOptional()
  @IsString()
  orderCodeSearch?: string;

  @IsOptional()
  @IsString()
  descriptionSearch?: string;

  @IsOptional()
  @IsString()
  productNoteSearch?: string;
}
