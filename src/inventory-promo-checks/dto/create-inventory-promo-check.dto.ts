import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

class InventoryPromoCheckItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  @Min(0)
  promoQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateInventoryPromoCheckDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryPromoCheckItemDto)
  items: InventoryPromoCheckItemDto[];
}
