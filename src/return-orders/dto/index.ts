import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReturnOrderDetailDto {
  @IsInt()
  invoiceId: number;

  @IsString()
  invoiceCode: string;

  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  invoiceQuantity: number;

  @IsNumber()
  invoicePrice: number;

  @IsNumber()
  @Min(0.01)
  requestQuantity: number;

  @IsNumber()
  @IsOptional()
  returnPrice?: number;

  @IsString()
  @IsOptional()
  note?: string;
}

export class CreateReturnOrderDto {
  @IsArray()
  invoiceIds: number[];

  @IsInt()
  branchId: number;

  @IsOptional()
  @IsInt()
  customerId?: number;

  @IsString()
  @IsOptional()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnOrderDetailDto)
  details: ReturnOrderDetailDto[];
}

export class ConfirmStockReceivedDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmDetailDto)
  details: ConfirmDetailDto[];

  @IsString()
  @IsOptional()
  note?: string;
}

export class ConfirmDetailDto {
  @IsInt()
  detailId: number;

  @IsNumber()
  @Min(0)
  confirmedQuantity: number;
}

export class ConfirmRefundDto {
  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsOptional()
  method?: string;

  @IsInt()
  @IsOptional()
  accountId?: number;
}

export class ReturnOrderQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerId?: number;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdBy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  invoiceId?: number;
}

export const RETURN_ORDER_STATUS = {
  REQUEST: 1,
  STOCK_RECEIVED: 2,
  REFUND_REQUESTED: 3,
  COMPLETED: 4,
  CANCELLED: 5,
};

export const RETURN_ORDER_STATUS_LABELS: Record<number, string> = {
  1: 'Yêu cầu trả hàng',
  2: 'Nhập hàng trả',
  3: 'Yêu cầu hoàn tiền',
  4: 'Hoàn thành',
  5: 'Đã hủy',
};
