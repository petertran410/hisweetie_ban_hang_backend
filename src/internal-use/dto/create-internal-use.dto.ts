import {
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
  Min,
  IsBoolean,
  IsIn,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

class InternalUseDetailDto {
  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsIn(['normal', 'damaged', 'near_expiry'])
  conditionType?: 'normal' | 'damaged' | 'near_expiry';

  @IsOptional()
  @IsDateString()
  soldExpiryDate?: string | null;
}

export class CreateInternalUseDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsInt()
  branchId: number;

  @IsInt()
  purposeId: number;

  @IsOptional()
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalUseDetailDto)
  internalUseDetails: InternalUseDetailDto[];
}
