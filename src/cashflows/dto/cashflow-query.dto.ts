import {
  IsOptional,
  IsInt,
  IsString,
  IsDateString,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CashFlowQueryDto {
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map(Number);
  })
  branchIds?: number[];

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    return Array.isArray(value) ? value : String(value).split(',');
  })
  code?: string[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  userId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map(Number);
  })
  accountIds?: number[];

  @IsOptional()
  @IsString()
  partnerType?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  partnerId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  invoiceId?: number;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    return Array.isArray(value) ? value : String(value).split(',');
  })
  method?: string[];

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map(Number);
  })
  cashFlowGroupId?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  usedForFinancialReporting?: number;

  @IsOptional()
  @IsString()
  partnerName?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @Transform(({ value, obj }) => {
    const raw = obj?.isReceipt;
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    return value;
  })
  @IsBoolean()
  isReceipt?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  status?: number;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr.map(Number);
  })
  ids?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  sortOrder?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
