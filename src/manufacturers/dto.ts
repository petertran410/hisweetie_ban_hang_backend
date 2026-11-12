import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt,
  IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { NSX_UNITS, NsxUnit, toNsxUnit } from '../common/nsx-pricing.util';

export class OwnMaterialDto {
  @IsInt() @Min(1) productId: number;
  @IsNumber() @Min(0.0001) quantity: number;
  @IsString() @MaxLength(40) unit: string;
}

/**
 * Dòng NSX bổ sung trên phiếu. Dòng mới: có productId, UNIT_PRICE, unit/priceUnit
 * thuộc g|kg|gói (kiểm tra chặt ở ManufacturersService.validateMaterials).
 * productId trống, TOTAL, priceUnit null chỉ còn để nhận hàng các phiếu cũ.
 */
export class ManufacturerMaterialDto {
  @IsOptional() @IsInt() @Min(1) productId?: number | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsIn(['UNIT_PRICE', 'TOTAL']) pricingMode: 'UNIT_PRICE' | 'TOTAL';
  @IsOptional() @IsNumber() @Min(0) quantity?: number | null;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @Transform(toNsxUnit) @IsIn(NSX_UNITS) priceUnit?: NsxUnit | null;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
}

export class ManufacturerDto {
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(40) contactNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsIn(['VND', 'CNY']) currency?: string;
  @IsOptional() @IsInt() @Min(1) supplierId?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PayableAllocationDto {
  @IsIn(['purchase_order', 'production']) targetType: 'purchase_order' | 'production';
  @IsInt() @Min(1) targetId: number;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsNumber() @Min(0) creditAmount?: number;
  @IsOptional() @IsNumber() @Min(0) foreignAmount?: number;
  @IsOptional() @IsNumber() @Min(0) creditForeignAmount?: number;
  @IsOptional() @IsNumber() @Min(0) exchangeRate?: number;
}

export class PayablePaymentDto {
  @IsString() @MaxLength(100) requestKey: string;
  @IsNumber() @Min(0) totalAmount: number;
  @IsInt() @Min(1) branchId: number;
  @IsIn(['cash', 'transfer']) method: string;
  @IsOptional() @IsInt() @Min(1) accountId?: number;
  @IsOptional() @IsInt() @Min(1) collectorUserId?: number;
  @IsOptional() @IsDateString() transDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true })
  @Type(() => PayableAllocationDto) allocations: PayableAllocationDto[];
}
