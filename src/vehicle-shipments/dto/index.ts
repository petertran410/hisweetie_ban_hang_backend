import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Một dòng hàng ghép lên xe: SP của một PDN (orderSupplierId) với SL ghép.
 * `contractNo` (Số HĐ) gắn với dòng — optional, dùng khi 1 PĐN có nhiều HĐ
 * hoặc 1 xe gồm hàng của nhiều HĐ. Cùng (osId, productId) có thể xuất hiện
 * nhiều dòng nếu khác contractNo.
 */
export class VehicleShipmentItemDto {
  @IsInt()
  orderSupplierId: number;

  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsString()
  @IsOptional()
  contractNo?: string;
}

/** File đính kèm phiếu xe (số hợp đồng, chứng từ...). */
export class VehicleFileDto {
  @IsString()
  filename: string;

  @IsString()
  url: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  mimetype?: string;

  @IsOptional()
  @IsString()
  originalname?: string;
}

export class CreateVehicleShipmentDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsInt()
  @IsOptional()
  borderGateId?: number;

  @IsString()
  @IsOptional()
  vehicleInfo?: string;

  @IsString()
  @IsOptional()
  description?: string;

  /**
   * Trạng thái khởi tạo: 0 = Phiếu tạm (lưu nháp), 1 = Đã xác nhận giao
   * (xe đang chạy). FE truyền theo nút người dùng bấm.
   */
  @IsInt()
  @IsOptional()
  status?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleFileDto)
  @IsOptional()
  files?: VehicleFileDto[];

  @IsDateString()
  @IsOptional()
  expectedArrivalDate?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleShipmentItemDto)
  items: VehicleShipmentItemDto[];
}

export class UpdateVehicleShipmentDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsInt()
  @IsOptional()
  borderGateId?: number;

  @IsString()
  @IsOptional()
  vehicleInfo?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  status?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleFileDto)
  @IsOptional()
  files?: VehicleFileDto[];

  @IsDateString()
  @IsOptional()
  expectedArrivalDate?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VehicleShipmentItemDto)
  @IsOptional()
  items?: VehicleShipmentItemDto[];
}

export class VehicleShipmentQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;

  @IsString()
  @IsOptional()
  search?: string;

  @IsString()
  @IsOptional()
  contractNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [];
  })
  @IsArray()
  branchIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  borderGateId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsString()
  @IsOptional()
  createdDateFrom?: string;

  @IsString()
  @IsOptional()
  createdDateTo?: string;
}

/**
 * Một dòng SP thực nhận khi sinh PN từ xe. `receivedQuantity` là SL thực tế
 * nhập kho (cho phép khác SL ghép — thất thoát/dư khi vận chuyển).
 */
export class CreatePOFromVehicleItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  receivedQuantity: number;

  @IsNumber()
  @IsOptional()
  price?: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  totalPrice?: number;

  @IsString()
  @IsOptional()
  description?: string;
}

/**
 * Một section trong modal "Tạo phiếu nhập": tương ứng một PDN trong xe.
 */
export class CreatePOFromVehicleSectionDto {
  @IsInt()
  orderSupplierId: number;

  @IsString()
  @IsOptional()
  code?: string;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePOFromVehicleItemDto)
  items: CreatePOFromVehicleItemDto[];
}

export class CreatePurchaseOrdersFromVehicleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePOFromVehicleSectionDto)
  sections: CreatePOFromVehicleSectionDto[];
}

export class CancelVehicleShipmentDto {
  @IsString()
  @IsOptional()
  reason?: string;
}

/**
 * Xử lý chênh lệch sau nhập cho 1 dòng hàng trên xe.
 *
 * Khuyến nghị dùng `vehicleShipmentItemId` để trỏ đúng dòng — bắt buộc khi 1
 * phiếu xe có 2 dòng cùng (orderSupplierId, productId) nhưng khác `contractNo`.
 * Fallback (orderSupplierId+productId) cho phiếu cũ chưa có `id`.
 */
export class ResolveVehicleItemDto {
  @IsInt()
  @IsOptional()
  vehicleShipmentItemId?: number;

  @IsInt()
  @IsOptional()
  orderSupplierId?: number;

  @IsInt()
  @IsOptional()
  productId?: number;

  @IsString()
  action: string; // pending | returned | kept
}
