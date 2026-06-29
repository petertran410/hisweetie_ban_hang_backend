import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

// ViewType nhóm báo cáo Hàng hóa (theo KiotViet Product group, bỏ BatchExpire vì
// không có dữ liệu lô/hạn dùng).
export const PRODUCT_VIEW_TYPES = [
  'ProductBySale', // Bán theo sản phẩm
  'ProductByProfit', // Lợi nhuận theo sản phẩm
  'ProductByCategory', // Bán theo nhóm hàng
  'InOutStock', // Nhập - Xuất - Tồn
  'InOutStockDetail', // Chi tiết thẻ kho
  'ProductByUser', // Bán theo SP × nhân viên
  'ProductByCustomer', // Bán theo SP × khách hàng
  'ProductBySupplier', // Bán theo SP × nhà cung cấp
  'DamageItem', // Hàng hỏng / hủy
] as const;

export type ProductViewType = (typeof PRODUCT_VIEW_TYPES)[number];

export const CATEGORY_LEVELS = ['parent', 'middle', 'child'] as const;
export type CategoryLevel = (typeof CATEGORY_LEVELS)[number];

export class ProductReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(PRODUCT_VIEW_TYPES)
  viewType?: ProductViewType;

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
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  productId?: number;

  @IsOptional()
  @IsString()
  productKeyword?: string;

  @IsOptional()
  @IsString()
  @IsIn(CATEGORY_LEVELS)
  categoryLevel?: CategoryLevel;

  @IsOptional()
  @IsString()
  categoryValue?: string;

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
