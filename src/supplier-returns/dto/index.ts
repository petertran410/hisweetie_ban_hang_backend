import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
  ValidateNested,
  Min,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export const SUPPLIER_RETURN_STATUS = {
  REQUEST: 1,
  STOCK_EXPORTED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
  DRAFT: 5,
  STOCK_EXPORT_DRAFT: 6,
} as const;

export const SUPPLIER_RETURN_STATUS_LABELS: Record<number, string> = {
  1: 'Yêu cầu trả hàng nhập',
  2: 'Đã xuất kho',
  3: 'Hoàn thành',
  4: 'Đã hủy',
  5: 'Phiếu tạm',
  6: 'Đang xuất kho (tạm)',
};

// ─── Create ───────────────────────────────────────────────────────────────────

export class CreateSupplierReturnDetailDto {
  @IsOptional()
  @IsInt()
  purchaseOrderId?: number;

  @IsOptional()
  @IsString()
  purchaseOrderCode?: string;

  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  @Min(0)
  purchaseQuantity: number;

  @IsNumber()
  @Min(0)
  purchasePrice: number;

  @IsNumber()
  @Min(0)
  requestQuantity: number;

  @IsNumber()
  @Min(0)
  returnPrice: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateSupplierReturnDto {
  @IsString()
  @IsIn(['by_purchase_order', 'by_product'])
  mode: 'by_purchase_order' | 'by_product';

  @IsOptional()
  @IsInt()
  purchaseOrderId?: number;

  @IsInt()
  supplierId: number;

  @IsInt()
  branchId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsArray()
  images?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierReturnDetailDto)
  details: CreateSupplierReturnDetailDto[];
}

// ─── Confirm Export (Bước 2) ──────────────────────────────────────────────────

export class ConfirmExportDetailDto {
  @IsInt()
  detailId: number;

  @IsNumber()
  @Min(0)
  confirmedQuantity: number;

  /**
   * Loại hàng trả NCC. Mirror RO step 2: nếu trả hàng damaged thì trừ
   * `inventory.damagedQuantity`; near_expiry trừ `nearExpiryQuantity`;
   * normal chỉ trừ `onHand`.
   *
   * Default 'normal' để tương thích với data cũ.
   */
  @IsOptional()
  @IsString()
  @IsIn(['normal', 'damaged', 'near_expiry'])
  conditionType?: 'normal' | 'damaged' | 'near_expiry';
}

export class ConfirmExportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmExportDetailDto)
  details: ConfirmExportDetailDto[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}

// ─── Confirm Refund (Bước 3) ──────────────────────────────────────────────────

export class ConfirmRefundDto {
  @IsString()
  @IsIn(['cash_refund', 'debt_offset'])
  refundType: 'cash_refund' | 'debt_offset';

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsInt()
  accountId?: number;

  @IsOptional()
  @IsInt()
  cashFlowGroupId?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export class SupplierReturnQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  supplierId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsInt({ each: true })
  supplierIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @IsString()
  mode?: string;

  @IsOptional()
  @IsString()
  refundType?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  createdBy?: number;
}

export class UpdateStep1DetailDto {
  @IsInt()
  productId: number;

  @IsOptional()
  @IsInt()
  purchaseOrderId?: number;

  @IsOptional()
  @IsString()
  purchaseOrderCode?: string;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  @Min(0)
  purchaseQuantity: number;

  @IsNumber()
  @Min(0)
  purchasePrice: number;

  @IsNumber()
  @Min(0)
  requestQuantity: number;

  @IsNumber()
  @Min(0)
  returnPrice: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateStep1Dto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateStep1DetailDto)
  details: UpdateStep1DetailDto[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}

export class ImportSupplierReturnDetailDto {
  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsNumber()
  @Min(0)
  returnPrice: number;

  @IsNumber()
  @Min(0)
  totalAmount: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ImportSupplierReturnItemDto {
  @IsString()
  code: string;

  @IsString()
  branchName: string;

  @IsString()
  supplierCode: string;

  @IsString()
  supplierName: string;

  @IsOptional()
  @IsString()
  returnedAt?: string;

  @IsOptional()
  @IsString()
  exportedByName?: string;

  @IsOptional()
  @IsString()
  createdByName?: string;

  @IsNumber()
  @Min(0)
  totalReturnAmount: number;

  @IsOptional()
  @IsString()
  statusText?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportSupplierReturnDetailDto)
  details: ImportSupplierReturnDetailDto[];
}

export class ImportSupplierReturnsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportSupplierReturnItemDto)
  items: ImportSupplierReturnItemDto[];
}
