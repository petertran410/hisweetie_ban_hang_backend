import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EvaluateItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  enabledPromotionIds?: number[];
}

export class EvaluatePromotionDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsInt()
  customerId?: number;

  @IsOptional()
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsString()
  purchaseDate?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvaluateItemDto)
  items: EvaluateItemDto[];
}
