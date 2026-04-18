import {
  IsInt,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsString,
  IsDateString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class InvoiceAllocationDto {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

  @IsNumber()
  amount: number;
}

class DebtOffsetDto {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

  @IsNumber()
  amount: number;
}

export class CreateCashFlowDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  cashFlowGroupId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  collectionBranchId?: number;

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
  collectorUserId?: number;

  @IsOptional()
  @IsBoolean()
  affectDebt?: boolean;

  @IsOptional()
  @IsBoolean()
  allocateToInvoices?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceAllocationDto)
  invoiceAllocations?: InvoiceAllocationDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DebtOffsetDto)
  debtOffsets?: DebtOffsetDto[];
}
