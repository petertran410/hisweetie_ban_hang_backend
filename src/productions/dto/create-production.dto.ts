import {
  IsInt,
  IsString,
  IsOptional,
  IsDecimal,
  IsDateString,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductionDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsInt()
  @Type(() => Number)
  sourceBranchId: number;

  @IsInt()
  @Type(() => Number)
  destinationBranchId: number;

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

  @IsOptional()
  @IsBoolean()
  autoDeductComponents?: boolean;
}
