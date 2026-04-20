import {
  IsInt,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductionComponentDto {
  @IsInt()
  @Type(() => Number)
  componentProductId: number;

  @IsNumber()
  @Type(() => Number)
  formulaGrams: number;

  @IsNumber()
  @Type(() => Number)
  actualGrams: number;
}

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

  @IsNumber()
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductionComponentDto)
  components?: ProductionComponentDto[];
}
