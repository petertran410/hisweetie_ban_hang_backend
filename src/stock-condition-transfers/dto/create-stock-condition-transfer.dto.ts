import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsNumber,
  Min,
  IsIn,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ALL_BUCKETS } from '../../common/stock-condition-onhand.util';

class StockConditionTransferItemDto {
  @IsInt()
  productId: number;

  // Loại đích chuyển đến: DAMAGED | NEAR_EXPIRY | PROMO
  @IsIn(ALL_BUCKETS as unknown as string[])
  toBucket: string;

  @IsNumber()
  @Min(0)
  quantity: number;

  // Bắt buộc khi toBucket = NEAR_EXPIRY (validate ở service).
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateStockConditionTransferDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsDateString()
  transferDate?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockConditionTransferItemDto)
  items: StockConditionTransferItemDto[];
}
