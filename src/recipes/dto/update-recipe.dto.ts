import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateRecipeIngredientDto, CreateRecipeMediaDto, CreateRecipeStepDto } from './create-recipe.dto';

export class UpdateRecipeDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsIn(['SEMI_FINISHED', 'FINISHED_PRODUCT'])
  type?: 'SEMI_FINISHED' | 'FINISHED_PRODUCT';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  categoryId?: number | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  outputProductId?: number | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0.000001)
  quantity?: number | null;

  @IsOptional()
  @IsIn(['ml', 'gram'])
  quantityUnit?: 'ml' | 'gram' | null;

  @IsOptional()
  @IsString()
  unit?: string | null;

  @IsOptional()
  @IsString()
  storage?: string | null;

  @IsOptional()
  @IsString()
  changeNote?: string | null;

  /** Replace toàn bộ ingredients của draft version */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRecipeIngredientDto)
  ingredients?: CreateRecipeIngredientDto[];

  /** Replace toàn bộ steps của draft version */
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

export class PublishRecipeDto {
  @IsOptional()
  @IsString()
  changeNote?: string;
}

export class CloneRecipeDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}
