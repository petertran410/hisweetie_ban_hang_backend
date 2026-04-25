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

class StockAuditItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  @Min(0)
  actualQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateStockAuditDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockAuditItemDto)
  items: StockAuditItemDto[];
}
