import {
  IsInt,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsIn,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductionComponentDto {
  @IsInt()
  @Type(() => Number)
  componentProductId: number;

  @IsNumber()
  @Type(() => Number)
  formulaGrams: number;

  @IsNumber()
  @Type(() => Number)
  actualGrams: number;
}

export class CreateProductionDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsInt()
  @Type(() => Number)
  sourceBranchId: number;

  @IsInt()
  @Type(() => Number)
  destinationBranchId: number;

  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsNumber()
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  status?: number;

  @IsOptional()
  @IsDateString()
  manufacturedDate?: string;

  @IsOptional()
  @IsBoolean()
  autoDeductComponents?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductionComponentDto)
  components?: ProductionComponentDto[];

  // Công thức thành phần đã chọn (bỏ trống → công thức mặc định).
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  formulaId?: number;

  // ── Gửi sản xuất ở nhà máy ngoài ────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  isExternal?: boolean;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number | null;

  // NCC ghi nhận phí sản xuất (công nợ). Bắt buộc với phiếu gửi.
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsIn(['VND', 'CNY'])
  feeCurrency?: string;

  // Phí sản xuất cả lô bằng VND (dùng khi feeCurrency = VND).
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  processingFee?: number;

  // Phí bằng ngoại tệ + tỷ giá (dùng khi feeCurrency = CNY).
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  feeForeignAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  feeExchangeRate?: number;
}
