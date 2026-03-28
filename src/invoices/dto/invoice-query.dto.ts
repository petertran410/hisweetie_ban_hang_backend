import {
  IsOptional,
  IsInt,
  IsString,
  IsDateString,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class InvoiceQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  customerIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  parentCustomerId?: number;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  statusIds?: number[];

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsDateString()
  fromPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  toPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  fromCreatedDate?: string;

  @IsOptional()
  @IsDateString()
  toCreatedDate?: string;
}
