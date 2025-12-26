import {
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsString,
} from 'class-validator';

export class CreateInvoiceDto {
  @IsNotEmpty()
  @IsNumber()
  customerId: number;

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @IsNumber()
  saleChannelId?: number;

  @IsOptional()
  purchaseDate?: string;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsOptional()
  @IsNumber()
  totalPayment?: number;

  @IsOptional()
  @IsBoolean()
  usingCod?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  items: InvoiceItemDto[];

  @IsOptional()
  delivery?: DeliveryDto;
}

export class UpdateInvoiceDto {
  @IsOptional()
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsOptional()
  purchaseDate?: string;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsOptional()
  @IsNumber()
  totalPayment?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  invoiceStatus?: number;

  @IsOptional()
  @IsArray()
  items?: InvoiceItemDto[];

  @IsOptional()
  delivery?: DeliveryDto;
}

export class InvoiceItemDto {
  @IsNotEmpty()
  @IsNumber()
  productId: number;

  @IsNotEmpty()
  @IsNumber()
  quantity: number;

  @IsNotEmpty()
  @IsNumber()
  unitPrice: number;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  serialNumbers?: string;
}

export class DeliveryDto {
  @IsOptional()
  @IsString()
  receiver?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

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

  @IsOptional()
  @IsNumber()
  partnerDeliveryId?: number;
}

export class InvoiceQueryDto {
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
  status?: number;

  @IsOptional()
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsNumber()
  soldById?: number;

  @IsOptional()
  @IsNumber()
  saleChannelId?: number;
}
