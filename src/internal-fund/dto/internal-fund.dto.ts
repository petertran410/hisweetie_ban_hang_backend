import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InternalFundQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsIn(['RECEIPT', 'EXPENSE', 'TRANSFER_IN', 'TRANSFER_OUT'])
  transactionType?: string;

  @IsOptional()
  @IsIn([
    'POSTED',
    'CANCELLED',
    'PENDING',
    'APPROVED',
    'REJECTED',
    'CREATE_FAILED',
  ])
  status?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit = 30;
}

export class CreateInternalFundReceiptApprovalDto {
  @IsUUID()
  clientUuid: string;

  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['OTHER', 'REFUND_ADVANCE', 'INTERNAL_TRANSFER'])
  classification?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  destinationBranchId?: number;

  @IsOptional()
  @IsIn(['cash', 'transfer'])
  method?: string;

  @IsOptional()
  @IsString()
  cashSource?: string;

  @IsOptional()
  @IsString()
  payerOpenId?: string;

  @IsOptional()
  @IsString()
  tempAdvance?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentCodes?: string[];

  @IsOptional()
  @IsArray()
  attachmentFiles?: InternalFundAttachmentDto[];
}

export class InternalFundAttachmentDto {
  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;
}

export class MarkInternalFundExpenseDto {
  @IsBoolean()
  issued: boolean;
}

export class CloseInternalFundDayDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsDateString()
  closingDate: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  actualOpeningBalance?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  actualReceipt?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  actualExpense?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  actualClosingBalance?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CancelInternalFundTransferDto {
  @IsString()
  reason: string;
}

export class UpdateInternalFundTransactionDto {
  @IsString()
  reason: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
