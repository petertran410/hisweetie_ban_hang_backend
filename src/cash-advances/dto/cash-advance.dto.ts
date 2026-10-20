import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CASH_ADVANCE_BRANCH_IDS,
  CASH_ADVANCE_PERIOD_MODE,
} from '../cash-advance.constants';

const MAX_AMOUNT = 1_000_000_000_000;

export class CashAdvanceAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  fileUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;
}

export class CreateCashAdvanceDto {
  @IsInt()
  @IsIn([...CASH_ADVANCE_BRANCH_IDS])
  @Type(() => Number)
  branchId: number;

  @IsInt()
  @Type(() => Number)
  recipientId: number;

  @IsInt()
  @Min(1000)
  @Max(MAX_AMOUNT)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  advanceDate: string;

  @IsIn(Object.values(CASH_ADVANCE_PERIOD_MODE))
  periodMode: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  periodYear?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  periodWeek?: number;

  @IsOptional()
  @IsDateString()
  periodFrom?: string;

  @IsOptional()
  @IsDateString()
  periodTo?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashAdvanceAttachmentDto)
  attachments?: CashAdvanceAttachmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientUuid?: string;
}

export class UpdateCashAdvanceDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  recipientId?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(MAX_AMOUNT)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsDateString()
  advanceDate?: string;

  @IsOptional()
  @IsIn(Object.values(CASH_ADVANCE_PERIOD_MODE))
  periodMode?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  periodYear?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  periodWeek?: number;

  @IsOptional()
  @IsDateString()
  periodFrom?: string;

  @IsOptional()
  @IsDateString()
  periodTo?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashAdvanceAttachmentDto)
  attachments?: CashAdvanceAttachmentDto[];
}

export class CashAdvanceQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  /** Một hoặc nhiều trạng thái, cách nhau bằng dấu phẩy. */
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  recipientId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  createdBy?: number;

  /** Kỳ tạm ứng giao với khoảng ngày này. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** NEEDS_REFUND: hết kỳ còn tiền chưa hoàn ứng; OVERDUE: quá hạn hoàn ứng. */
  @IsOptional()
  @IsIn(['NEEDS_REFUND', 'OVERDUE'])
  refundState?: string;

  @IsOptional()
  @IsIn(['advanceDate', 'amount', 'createdAt'])
  orderBy?: 'advanceDate' | 'amount' | 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit = 30;
}

export class RecipientStatusQueryDto {
  @IsInt()
  @Type(() => Number)
  recipientId: number;
}

export class FundBalanceQueryDto {
  @IsInt()
  @IsIn([...CASH_ADVANCE_BRANCH_IDS])
  @Type(() => Number)
  branchId: number;
}

export class SignedVoucherDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashAdvanceAttachmentDto)
  attachments: CashAdvanceAttachmentDto[];
}

export class CashAdvanceReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class CreateCashAdvanceRefundDto {
  @IsInt()
  @Type(() => Number)
  advanceId: number;

  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  refundDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashAdvanceAttachmentDto)
  attachments?: CashAdvanceAttachmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientUuid?: string;
}

export class UpdateCashAdvanceRefundDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsDateString()
  refundDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CashAdvanceAttachmentDto)
  attachments?: CashAdvanceAttachmentDto[];
}

export class CashAdvanceRefundQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  refunderId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  advanceId?: number;

  /** Ngày hoàn ứng trong khoảng này. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit = 30;
}
