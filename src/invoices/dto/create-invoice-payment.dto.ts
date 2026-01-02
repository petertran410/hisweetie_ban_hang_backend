import {
  IsInt,
  IsOptional,
  IsString,
  IsDateString,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateInvoicePaymentDto {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

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
  notes?: string;
}
