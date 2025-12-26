import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsDateString,
  IsArray,
  ValidateNested,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

class CreateInvoiceDetailDto {
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

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsNumber()
  totalPrice: number;

  @IsOptional()
  @IsString()
  note?: string;
}

class CreateInvoiceDeliveryDto {
  @IsString()
  receiver: string;

  @IsString()
  contactNumber: string;

  @IsString()
  address: string;

  @IsOptional()
  @IsString()
  locationName?: string;

  @IsOptional()
  @IsString()
  wardName?: string;

  @IsOptional()
  @IsNumber()
  weight?: number;

  @IsOptional()
  @IsNumber()
  length?: number;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;
}

export class CreateInvoiceDto {
  @IsOptional()
  @IsInt()
  customerId?: number;

  @IsOptional()
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsInt()
  soldById?: number;

  @IsOptional()
  @IsInt()
  saleChannelId?: number;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsBoolean()
  usingCod?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsOptional()
  @IsNumber()
  paidAmount?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceDetailDto)
  items: CreateInvoiceDetailDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateInvoiceDeliveryDto)
  delivery?: CreateInvoiceDeliveryDto;
}
