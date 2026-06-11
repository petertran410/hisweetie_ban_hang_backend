import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

// Các ViewType của nhóm báo cáo Bán hàng (theo KiotViet Sale group).
export const SALE_VIEW_TYPES = [
  'PurchaseDate', // Theo thời gian (ngày)
  'Profit', // Lợi nhuận theo thời gian
  'SoldBy', // Theo nhân viên bán
  'Branch', // Theo chi nhánh
  'Refund', // Trả hàng
] as const;

export type SaleViewType = (typeof SALE_VIEW_TYPES)[number];

export class SaleReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(SALE_VIEW_TYPES)
  viewType?: SaleViewType;

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
  soldById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  saleChannelId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priceBookId?: number;

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
}
