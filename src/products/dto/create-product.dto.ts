import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InventoryDto {
  @IsNumber()
  branchId: number;

  @IsOptional()
  @IsString()
  branchName?: string;

  @IsOptional()
  @IsNumber()
  cost?: number;

  @IsOptional()
  @IsNumber()
  onHand?: number;

  @IsOptional()
  @IsNumber()
  minQuality?: number;

  @IsOptional()
  @IsNumber()
  maxQuality?: number;
}

export class ComponentDto {
  @IsNumber()
  componentProductId: number;

  @IsNumber()
  quantity: number;
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

  @IsNumber()
  type: number;

  @IsOptional()
  @IsNumber()
  categoryId?: number;

  @IsOptional()
  @IsNumber()
  tradeMarkId?: number;

  @IsOptional()
  @IsNumber()
  variantId?: number;

  @IsOptional()
  @IsNumber()
  masterProductId?: number;

  @IsOptional()
  @IsNumber()
  masterUnitId?: number;

  @IsOptional()
  @IsNumber()
  purchasePrice?: number;

  @IsOptional()
  @IsNumber()
  retailPrice?: number;

  @IsOptional()
  @IsNumber()
  basePrice?: number;

  @IsOptional()
  @IsNumber()
  stockQuantity?: number;

  @IsOptional()
  @IsNumber()
  minStockAlert?: number;

  @IsOptional()
  @IsNumber()
  maxStockAlert?: number;

  @IsOptional()
  @IsNumber()
  weight?: number;

  @IsOptional()
  @IsString()
  weightUnit?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  conversionValue?: number;

  @IsOptional()
  @IsString()
  attributesText?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDirectSale?: boolean;

  @IsOptional()
  @IsBoolean()
  isRewardPoint?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components?: ComponentDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryDto)
  initialInventory?: InventoryDto[];

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @IsString()
  costScope?: 'all' | 'specific';

  @IsOptional()
  @IsNumber()
  costBranchId?: number;
}
