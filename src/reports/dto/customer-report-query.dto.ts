import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export const CUSTOMER_VIEW_TYPES = [
  'CustomerBySale',
  'CustomerByProfit',
  'CustomerDebt',
  'CustomerByProduct',
] as const;

export type CustomerViewType = (typeof CUSTOMER_VIEW_TYPES)[number];

export class CustomerReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(CUSTOMER_VIEW_TYPES)
  viewType?: CustomerViewType;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerGroupId?: number;

  @IsOptional()
  @IsString()
  customerKeyword?: string;

  @IsOptional()
  @IsString()
  productKeyword?: string;

  // ── Bộ lọc sản phẩm (CSV, dùng cho CustomerBySale/Profit/Product) ──
  // Pattern đồng nhất với ProductQueryDto (CSV → array ở service).
  @IsOptional()
  @IsString()
  types?: string;

  @IsOptional()
  @IsString()
  parentNames?: string;

  @IsOptional()
  @IsString()
  middleNames?: string;

  @IsOptional()
  @IsString()
  childNames?: string;

  @IsOptional()
  @IsString()
  tradeMarkIds?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  typeOfCustomer?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  rankStart?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  rankEnd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  top?: number;
}
