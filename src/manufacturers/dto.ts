import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt,
  IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class OwnMaterialDto {
  @IsInt() @Min(1) productId: number;
  @IsNumber() @Min(0.0001) quantity: number;
  @IsString() @MaxLength(40) unit: string;
}

export class ManufacturerMaterialDto {
  @IsOptional() @IsInt() @Min(1) productId?: number | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsIn(['UNIT_PRICE', 'TOTAL']) pricingMode: 'UNIT_PRICE' | 'TOTAL';
  @IsOptional() @IsNumber() @Min(0) quantity?: number | null;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
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

export class ExternalTemplateDto {
  @IsString() @MaxLength(200) name: string;
  @IsInt() @Min(1) manufacturerId: number;
  @IsInt() @Min(1) productId: number;
  @IsNumber() @Min(0.0001) baseQuantity: number;
  @IsIn(['VND', 'CNY']) currency: string;
  @IsOptional() @IsNumber() @Min(0) processingFee?: number;
  @IsOptional() @IsNumber() @Min(0) exchangeRate?: number;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true })
  @Type(() => OwnMaterialDto) ownMaterials: OwnMaterialDto[];
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true })
  @Type(() => ManufacturerMaterialDto) manufacturerMaterials: ManufacturerMaterialDto[];
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
