import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRecipeIngredientDto {
  @IsIn(['PRODUCT', 'SEMI_FINISHED', 'CUSTOM'])
  sourceType: 'PRODUCT' | 'SEMI_FINISHED' | 'CUSTOM';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  recipeReferenceId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  ingredientId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  customUnit?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  customPrice?: number;

  @IsNumber()
  @Type(() => Number)
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsBoolean()
  includeInCost?: boolean;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsBoolean()
  isTemporary?: boolean;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class CreateRecipeStepDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsString()
  content: string;

  @IsOptional()
  tools?: any;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class CreateRecipeMediaDto {
  @IsIn(['IMAGE', 'VIDEO'])
  mediaType: 'IMAGE' | 'VIDEO';

  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  altText?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class CreateRecipeCategoryDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsIn(['SEMI_FINISHED', 'FINISHED_PRODUCT'])
  type?: 'SEMI_FINISHED' | 'FINISHED_PRODUCT';
}

export class CreateRecipeDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsString()
  @MaxLength(255)
  name: string;

  @IsIn(['SEMI_FINISHED', 'FINISHED_PRODUCT'])
  type: 'SEMI_FINISHED' | 'FINISHED_PRODUCT';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  categoryId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  outputProductId?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0.000001)
  quantity?: number;

  @IsOptional()
  @IsIn(['ml', 'gram'])
  quantityUnit?: 'ml' | 'gram';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsString()
  storage?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients?: CreateRecipeIngredientDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeStepDto)
  steps?: CreateRecipeStepDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeMediaDto)
  media?: CreateRecipeMediaDto[];
}
