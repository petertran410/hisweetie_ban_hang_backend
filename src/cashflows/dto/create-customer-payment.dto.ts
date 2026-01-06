import {
  IsInt,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class InvoicePaymentItem {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

  @IsNumber()
  amount: number;
}

export class CreateCustomerPaymentDto {
  @IsInt()
  @Type(() => Number)
  customerId: number;

  @IsNumber()
  totalAmount: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsDateString()
  transDate?: string;

  @IsString()
  method: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoicePaymentItem)
  invoices: InvoicePaymentItem[];
}
