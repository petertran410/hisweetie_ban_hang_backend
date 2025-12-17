import {
  IsString,
  IsBoolean,
  IsOptional,
  IsArray,
  IsNumber,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PriceBookProductDto {
  @IsNumber()
  productId: number;

  @IsNumber()
  price: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreatePriceBookDto {
  @IsString()
  name: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @IsBoolean()
  @IsOptional()
  isGlobal?: boolean = false;

  @IsDateString()
  @IsOptional()
  startDate?: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsBoolean()
  @IsOptional()
  allowNonListedProducts?: boolean = true;

  @IsBoolean()
  @IsOptional()
  warnNonListedProducts?: boolean = false;

  @IsNumber()
  @IsOptional()
  priority?: number = 0;

  @IsBoolean()
  @IsOptional()
  forAllCusGroup?: boolean = false;

  @IsBoolean()
  @IsOptional()
  forAllUser?: boolean = false;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceBookProductDto)
  @IsOptional()
  products?: PriceBookProductDto[];

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  branches?: number[];

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  customerGroups?: number[];

  @IsArray()
  @IsNumber({}, { each: true })
  @IsOptional()
  users?: number[];
}
