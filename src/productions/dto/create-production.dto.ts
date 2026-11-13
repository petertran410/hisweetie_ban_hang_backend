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
import { ManufacturerMaterialDto, OwnMaterialDto } from '../../manufacturers/dto';

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
  @IsOptional() @IsInt() @Min(1) manufacturerId?: number;
  // Mẫu phối trộn đã bỏ: vẫn nhận để client cũ không bị từ chối, server bỏ qua.
  @IsOptional() @IsInt() @Min(1) externalTemplateId?: number | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => OwnMaterialDto) ownMaterials?: OwnMaterialDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => ManufacturerMaterialDto) manufacturerMaterials?: ManufacturerMaterialDto[];
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

  // Phiếu gửi NSX đã gửi: sửa ngày gửi (ngày ghi xuất kho nguyên liệu).
  @IsOptional()
  @IsDateString()
  sentDate?: string;

  @IsOptional()
  @IsBoolean()
  autoDeductComponents?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductionComponentDto)
  components?: ProductionComponentDto[];

  // Công thức thành phần đã chọn (bỏ trống → công thức mặc định).
  // Phiếu gửi NSX: công thức gửi đi (isExternal) của thành phẩm, null = nhập tay.
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  formulaId?: number | null;

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
