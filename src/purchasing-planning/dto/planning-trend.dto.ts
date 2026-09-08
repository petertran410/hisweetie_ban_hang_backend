import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreatePlanningTrendDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  productId?: number;

  @IsOptional()
  @IsString()
  categoryName?: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsIn(['UPLIFT', 'QUANTITY'])
  kind?: 'UPLIFT' | 'QUANTITY';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  upliftFactor?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  extraQuantity?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdatePlanningTrendDto extends PartialType(CreatePlanningTrendDto) {}
