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

class InventoryCheckItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  @Min(0)
  damagedQuantity: number;

  @IsNumber()
  @Min(0)
  nearExpiryQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateInventoryCheckDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryCheckItemDto)
  items: InventoryCheckItemDto[];
}
