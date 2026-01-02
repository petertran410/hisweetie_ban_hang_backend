import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsDateString,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCashFlowDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  cashFlowGroupId?: number;

  @IsBoolean()
  isReceipt: boolean;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsDateString()
  transDate?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsOptional()
  @IsString()
  partnerType?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  partnerId?: number;

  @IsOptional()
  @IsString()
  partnerName?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  wardName?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  usedForFinancialReporting?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  invoiceId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  purchaseOrderId?: number;
}
