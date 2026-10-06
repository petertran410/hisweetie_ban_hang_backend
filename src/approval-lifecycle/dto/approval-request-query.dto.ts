import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

const APPROVAL_KINDS = ['EXPENSE_HN', 'EXPENSE_SG', 'EXPENSE_VP', 'RECEIPT'];
const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELED',
  'DELETED',
  'REVERTED',
  'CREATE_FAILED',
];

export class ApprovalRequestQueryDto {
  @IsOptional()
  @IsIn(APPROVAL_KINDS)
  kind?: string;

  @IsOptional()
  @IsIn(APPROVAL_STATUSES)
  status?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

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
