import { IsOptional, IsInt, IsString, IsBoolean, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class ProductQualityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return String(value)
      .split(',')
      .map((v) => Number(v.trim()))
      .filter(Boolean);
  })
  @IsArray()
  branchIds?: number[];

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  })
  @IsArray()
  statuses?: string[];

  @IsOptional()
  @IsString()
  initialClassification?: string;

  @IsOptional()
  @IsString()
  feedbackType?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assignedUserId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  decisionMakerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  productId?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isOverdue?: boolean;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsString()
  tab?: string; // 'all' | 'new' | 'processing' | 'overdue' | 'completed' | 'my'

  @IsOptional()
  @IsString()
  orderBy?: string; // 'createdAt' | 'dueAt' | 'handledAt'

  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';
}
