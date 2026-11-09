import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  IsIn,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

// Query lặp (?k=a&k=b) → mảng; 1 giá trị → mảng 1 phần tử.
// Không tách theo dấu phẩy vì tên nhóm hàng có thể chứa dấu phẩy.
const toStringArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
};

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

// Như trên, cho id số: ?tradeMarkIds=1&tradeMarkIds=2 → [1, 2].
const toNumberArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  return (Array.isArray(value) ? value : [value]).map(Number);
};

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

  // Lọc nhiều nhóm hàng cùng lúc (cùng cấp `categoryLevel`).
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  categoryValues?: string[];

  // Lọc theo thương hiệu (nhiều id).
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @IsInt({ each: true })
  tradeMarkIds?: number[];

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
