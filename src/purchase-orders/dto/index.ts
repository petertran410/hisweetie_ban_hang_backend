import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsNumber,
  IsIn,
  Min,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class PurchaseOrderItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  // Thành tiền do FE tính sẵn (số nguyên). Khi có, BE lưu thẳng giá trị này
  // thay vì recompute (price - discount) * quantity — tránh sai lệch do đơn
  // giá có tới 3 số thập phân (vd 333.333 * 3 = 999.999). Nếu không gửi,
  // BE fallback về công thức cũ.
  @IsNumber()
  @IsOptional()
  totalPrice?: number;

  @IsString()
  @IsOptional()
  description?: string;

  // Số thứ tự dòng (1, 2, 3...) trong phiếu. BE tự generate nếu FE không
  // gửi. Đảm bảo cùng 1 sản phẩm có thể xuất hiện nhiều dòng (vd 1 dòng
  // hàng thường + 1 dòng loại B) — mirror pattern OrderItem.lineNumber.
  @IsInt()
  @Min(1)
  @IsOptional()
  lineNumber?: number;

  // Phân loại hàng: "normal" (hàng thường, mặc định) hoặc "damaged" (loại B
  // = bục rách). Khi hoàn thành phiếu, phần "damaged" cộng vào
  // Inventory.damagedQuantity; phần "normal" cộng vào Inventory.onHand.
  @IsString()
  @IsIn(['normal', 'damaged'])
  @IsOptional()
  conditionType?: 'normal' | 'damaged';
}

export class PurchaseOrderSurchargeDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsNumber()
  @IsOptional()
  value?: number;

  @IsNumber()
  @IsOptional()
  valueRatio?: number;

  @IsBoolean()
  @IsOptional()
  isSupplierExpense?: boolean;

  @IsInt()
  @IsOptional()
  type?: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  orderSupplierId?: number;

  @IsInt()
  supplierId: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderSurchargeDto)
  @IsOptional()
  surcharges?: PurchaseOrderSurchargeDto[];
}

export class UpdatePurchaseOrderDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsInt()
  @IsOptional()
  supplierId?: number;

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  @IsOptional()
  paidAmount?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  @IsOptional()
  items?: PurchaseOrderItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderSurchargeDto)
  @IsOptional()
  surcharges?: PurchaseOrderSurchargeDto[];
}

export class PurchaseOrderQueryDto {
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  supplierId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [];
  })
  @IsArray()
  supplierIds?: number[];

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
  createdById?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  purchaseById?: number;

  @IsString()
  @IsOptional()
  createdDateFrom?: string;

  @IsString()
  @IsOptional()
  createdDateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}

export class CreatePurchaseOrderFromOrderSupplierItemDto {
  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsNumber()
  totalPrice: number;

  @IsString()
  @IsOptional()
  description?: string;

  // Số thứ tự dòng trong phiếu (1, 2, 3...). BE tự generate nếu FE không
  // gửi — mirror với PurchaseOrderItemDto để đồng nhất giữa 2 entry point.
  @IsInt()
  @Min(1)
  @IsOptional()
  lineNumber?: number;

  // Phân loại hàng: "normal" (mặc định) hoặc "damaged" (loại B). Khi tạo
  // PN từ PDN, mặc định tất cả item là "normal" vì PDN không có field này.
  @IsString()
  @IsIn(['normal', 'damaged'])
  @IsOptional()
  conditionType?: 'normal' | 'damaged';
}

export class CreatePurchaseOrderFromOrderSupplierPaymentDto {
  @IsString()
  method: string;

  @IsNumber()
  amount: number;

  @IsInt()
  @IsOptional()
  accountId?: number;
}

export class CreatePurchaseOrderFromOrderSupplierDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsNumber()
  @IsOptional()
  additionalPayment?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderFromOrderSupplierPaymentDto)
  @IsOptional()
  payments?: CreatePurchaseOrderFromOrderSupplierPaymentDto[];

  @IsInt()
  @IsOptional()
  branchId?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsNumber()
  @IsOptional()
  discountRatio?: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  partnerType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  purchaseById?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderFromOrderSupplierItemDto)
  @IsOptional()
  items?: CreatePurchaseOrderFromOrderSupplierItemDto[];
}

export * from './cancel-purchase-order.dto';
