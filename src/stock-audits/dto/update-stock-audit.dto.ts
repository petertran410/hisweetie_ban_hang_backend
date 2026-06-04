import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
  IsNumber,
  IsInt,
  Min,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

class UpdateStockAuditItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  @Min(0)
  actualQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateStockAuditDto {
  // Thời điểm kiểm kho. Cho phép lùi ngày (backdated).
  @IsOptional()
  @IsDateString()
  checkDate?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateStockAuditItemDto)
  items?: UpdateStockAuditItemDto[];
}
