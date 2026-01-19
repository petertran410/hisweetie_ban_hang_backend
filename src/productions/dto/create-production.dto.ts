import {
  IsInt,
  IsString,
  IsOptional,
  IsDecimal,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductionDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsDecimal()
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  status?: number;

  @IsOptional()
  @IsDateString()
  manufacturedDate?: string;
}
