import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  Min,
  IsArray,
  IsInt,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';

export class InitialInventoryDto {
  @IsNumber()
  @Type(() => Number)
  branchId: number;

  @IsOptional()
  @IsString()
  branchName?: string;

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
  @IsNumber()
  @Type(() => Number)
  categoryId?: number;

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
  basePrice?: number;

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
  @IsString()
  attributesText?: string;

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
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

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
  @IsNumber()
  @Type(() => Number)
  categoryId?: number;

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
  purchasePrice?: number;

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
  @Min(0)
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
  @IsString()
  attributesText?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  imageUrls?: string[];

  @IsOptional()
  @IsBoolean()
  isDirectSale?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  type?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductComponentDto)
  components?: ProductComponentDto[];
}

export class ProductQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 15;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  categoryIds?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  branchId?: string;
}

export class ProductComponentDto {
  @IsInt()
  componentProductId: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  quantity: number;
}

export * from './create-product.dto';
export * from './update-product.dto';
export * from './product-query.dto';
