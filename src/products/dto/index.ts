import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  Min,
  IsArray,
  IsInt,
  IsDateString,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';

/**
 * Phân loại hàng hoá phục vụ leadtime chuyển kho (Phase 1 — hệ thống leadtime).
 * COLD = hàng lạnh (thời gian chuyển kho ngắn hơn), NORMAL = hàng thường.
 */
export const CARGO_TYPES = ['COLD', 'NORMAL'] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

export class InitialInventoryDto {
  @IsNumber()
  @Type(() => Number)
  branchId: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  onHand?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minQuality?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxQuality?: number;
}

export class ComponentDto {
  @IsNumber()
  @Type(() => Number)
  componentProductId: number;

  @IsNumber()
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsString()
  inputMode?: string;
}

export class ProductComponentDto {
  @IsNumber()
  @Type(() => Number)
  componentProductId: number;

  @IsNumber()
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsString()
  inputMode?: string;
}

export class ProductDocumentDto {
  @IsString()
  url: string;

  @IsOptional()
  @IsString()
  originalName?: string;

  @IsOptional()
  @IsString()
  mimetype?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  size?: number;
}

export class PublicationLocationDto {
  @IsOptional()
  @IsString()
  publisher?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  cityCode?: string;

  @IsOptional()
  @IsString()
  cityName?: string;

  @IsOptional()
  @IsString()
  districtCode?: string;

  @IsOptional()
  @IsString()
  districtName?: string;

  @IsOptional()
  @IsString()
  wardCode?: string;

  @IsOptional()
  @IsString()
  wardName?: string;

  @IsOptional()
  @IsString()
  newCityCode?: string;

  @IsOptional()
  @IsString()
  newCityName?: string;

  @IsOptional()
  @IsString()
  newWardCode?: string;

  @IsOptional()
  @IsString()
  newWardName?: string;
}

// Một cặp thuộc tính (title + value) do người dùng nhập ở form/import.
export class ProductAttributeInputDto {
  @IsString()
  name: string;

  @IsString()
  value: string;
}

/**
 * Một dòng gắn nhà máy cho sản phẩm.
 *
 * Chỉ mang thông tin quan hệ (nhà máy nào, vai trò gì, ưu tiên thứ mấy).
 * Giá / MOQ / leadtime thuộc trang nhà máy, không sửa qua form sản phẩm.
 */
export class ProductFactoryMappingDto {
  @IsInt()
  @Type(() => Number)
  factoryId: number;

  @IsIn(['primary', 'backup'])
  role: 'primary' | 'backup';

  /** 0 = ưu tiên cao nhất. Dùng để chọn nhà máy mặc định khi cần đúng một. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  priority?: number;
}

export class CreateProductDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  orderTemplate?: string;

  @IsOptional()
  @IsString()
  parentName?: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsString()
  childName?: string;

  // Misa product mapping
  @IsOptional()
  @IsString()
  misa_code?: string;

  @IsOptional()
  @IsString()
  misa_name?: string;

  @IsOptional()
  @IsString()
  misa_unit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  tradeMarkId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  variantId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  type?: number;

  @IsOptional()
  @IsBoolean()
  allowsSale?: boolean;

  @IsOptional()
  @IsBoolean()
  hasVariants?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  purchasePrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  basePrice?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  stockQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minStockAlert?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxStockAlert?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  conversionValue?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  weight?: number;

  @IsOptional()
  @IsString()
  weightUnit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  vat?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  shippingWeight?: number;

  @IsOptional()
  @IsString()
  shippingWeightUnit?: string;

  @IsOptional()
  @IsIn(CARGO_TYPES)
  cargoType?: CargoType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeInputDto)
  attributes?: ProductAttributeInputDto[];

  @IsOptional()
  @IsBoolean()
  isRewardPoint?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDirectSale?: boolean;

  @IsOptional()
  @IsBoolean()
  isPieceUnit?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductDocumentDto)
  documents?: ProductDocumentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PublicationLocationDto)
  publicationLocation?: PublicationLocationDto;

  @IsOptional()
  @IsDateString()
  publicationDate?: string;

  @IsOptional()
  @IsString()
  publicationLink?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InitialInventoryDto)
  initialInventory?: InitialInventoryDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components?: ComponentDto[];

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  costScope?: 'all' | 'specific';

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (value !== undefined && value !== null) return [Number(value)];
    return undefined;
  })
  costBranchIds?: number[];

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  masterProductId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  masterUnitId?: number;

  @IsOptional()
  @IsBoolean()
  manualCostOverride?: boolean;

  /**
   * Danh sách nhà máy của sản phẩm (nguồn chân lý — thay cho 2 field trên).
   *
   * Một sản phẩm gắn được **nhiều** nhà máy chính và **nhiều** backup. Một
   * nhà máy chỉ giữ đúng một vai trò (ràng buộc `@@unique([factoryId, productId])`).
   * Gửi lên là **toàn bộ** danh sách mong muốn — dòng thiếu sẽ bị gỡ.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductFactoryMappingDto)
  factoryMappings?: ProductFactoryMappingDto[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  orderTemplate?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsString()
  parentName?: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsString()
  childName?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  variantId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  tradeMarkId?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  basePrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  collaboratorPrice?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  stockQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minStockAlert?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxStockAlert?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  weight?: number;

  @IsOptional()
  @IsString()
  weightUnit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  vat?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  shippingWeight?: number;

  @IsOptional()
  @IsString()
  shippingWeightUnit?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  conversionValue?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  masterProductId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  masterUnitId?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  imageUrls?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductDocumentDto)
  documents?: ProductDocumentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PublicationLocationDto)
  publicationLocation?: PublicationLocationDto;

  @IsOptional()
  @IsDateString()
  publicationDate?: string;

  @IsOptional()
  @IsString()
  publicationLink?: string;

  @IsOptional()
  @IsBoolean()
  isDirectSale?: boolean;

  @IsOptional()
  @IsBoolean()
  isPieceUnit?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  type?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductComponentDto)
  components?: ProductComponentDto[];

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  costScope?: 'all' | 'specific';

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (value !== undefined && value !== null) return [Number(value)];
    return undefined;
  })
  costBranchIds?: number[];
}

export class ProductQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  categoryIds?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ obj, key }) => {
    // Đọc giá trị thô từ obj[key] thay vì `value`: với
    // enableImplicitConversion=true, class-transformer ép 'false' -> true
    // (Boolean('false')) TRƯỚC khi chạy @Transform, làm hỏng filter trạng thái.
    const raw = obj?.[key];
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return undefined;
  })
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(Number);
    }
    return Array.isArray(value) ? value.map(Number) : [Number(value)];
  })
  branchIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  type?: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(Number);
    }
    return Array.isArray(value) ? value.map(Number) : [Number(value)];
  })
  types?: number[];

  @IsOptional()
  @IsString()
  parentName?: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsString()
  childName?: string;

  /** Lọc theo phân loại hàng hoá: COLD | NORMAL */
  @IsOptional()
  @IsIn(CARGO_TYPES)
  cargoType?: CargoType;

  // ── Multi-select: cho phép lọc nhiều giá trị cùng lúc ──
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(String);
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  })
  parentNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(String);
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  })
  middleNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(String);
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  })
  childNames?: string[];

  @IsOptional()
  @IsString()
  stockStatus?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  tradeMarkId?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return String(value)
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => !Number.isNaN(n));
  })
  tradeMarkIds?: number[];

  @IsOptional()
  @IsBoolean()
  @Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return undefined;
  })
  isDirectSale?: boolean;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  priceBookId?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return undefined;
  })
  onlyInPriceBook?: boolean;

  /**
   * Danh sách key cột cần xuất (CSV), dùng cho endpoint /products/export.
   * Vd: "type,categoryPath,code,name,tradeMark,basePrice,cost,stock".
   */
  @IsOptional()
  @IsString()
  columns?: string;

  /**
   * Thời điểm tính tồn kho khi xuất file (ISO date string, vd "2026-07-20").
   * Chỉ áp dụng cho cột `stock` và chỉ khi có `branchId` (chi nhánh đang đứng).
   * Khi bỏ trống → tồn kho lấy theo inventory.onHand hiện tại.
   * Các cột khác (giá vốn, khách đặt, đặt NCC...) vẫn dùng giá trị hiện tại
   * vì hệ thống không lưu lịch sử các giá trị này theo ngày.
   */
  @IsOptional()
  @IsString()
  asOfDate?: string;

  /**
   * Cột cần sắp xếp. Hỗ trợ:
   * - Cột trực tiếp trên Product: basePrice
   * - Cột trên Inventory (theo chi nhánh đang chọn): cost, onHand, minQuality, maxQuality
   */
  @IsOptional()
  @IsString()
  orderBy?: string;

  /** Chiều sắp xếp: 'asc' | 'desc' (mặc định 'desc'). */
  @IsOptional()
  @IsString()
  orderDirection?: string;

  /**
   * Lọc sản phẩm theo NCC quản lý — dựa trên nhà máy (primary hoặc backup)
   * của sản phẩm thuộc NCC này. Dùng cho filter chặt trong OrderSupplierForm.
   */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  supplierId?: number;

  /**
   * Lọc sản phẩm theo ID nhà máy cụ thể. Kết hợp với `factoryRelation` để
   * xác định xem filter theo primary, backup hay cả hai.
   */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number;

  /**
   * Quan hệ với factoryId:
   * - 'primary': chỉ lấy sản phẩm gắn nhà máy này với vai trò chính
   * - 'backup': chỉ lấy sản phẩm gắn nhà máy này với vai trò backup
   * - 'either' (mặc định): filter sản phẩm có primary HOẶC backup match
   */
  @IsOptional()
  @IsString()
  factoryRelation?: 'primary' | 'backup' | 'either';

  /**
   * Lọc theo thời gian tạo sản phẩm (createdAt) — cận dưới (>=).
   * Nhận ISO date string, vd "2026-07-01T00:00:00.000Z".
   */
  @IsOptional()
  @IsDateString()
  fromCreatedDate?: string;

  /**
   * Lọc theo thời gian tạo sản phẩm (createdAt) — cận trên (<=).
   * Nhận ISO date string, vd "2026-07-08T23:59:59.999Z".
   */
  @IsOptional()
  @IsDateString()
  toCreatedDate?: string;
}

/**
 * Gán phân loại hàng hoá (COLD/NORMAL) cho nhiều sản phẩm cùng lúc.
 * Dùng cho việc khởi tạo dữ liệu cargoType trên toàn danh mục.
 */
export class BulkUpdateCargoTypeDto {
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  productIds!: number[];

  @IsIn(CARGO_TYPES)
  cargoType!: CargoType;
}
