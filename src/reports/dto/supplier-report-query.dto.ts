import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

// ViewType nhóm báo cáo Nhà cung cấp (bỏ VAT vì không có dữ liệu thuế).
export const SUPPLIER_VIEW_TYPES = [
  'PurchaseBySupplier', // Nhập theo nhà cung cấp
  'PurchaseByProduct', // Nhập theo sản phẩm
  'SupplierDebt', // Công nợ nhà cung cấp
  'SupplierReturn', // Trả hàng nhập
  'SupplierInfo', // Tổng hợp thông tin NCC
] as const;

export type SupplierViewType = (typeof SUPPLIER_VIEW_TYPES)[number];

export class SupplierReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(SUPPLIER_VIEW_TYPES)
  viewType?: SupplierViewType;

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
  supplierId?: number;

  @IsOptional()
  @IsString()
  keyword?: string;

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
