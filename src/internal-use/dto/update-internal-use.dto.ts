import {
  IsOptional,
  IsInt,
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsBoolean,
  IsIn,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

class UpdateInternalUseDetailDto {
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
  quantity: number;

  @IsOptional()
  @IsNumber()
  cost?: number;

  @IsOptional()
  @IsIn(['normal', 'damaged', 'near_expiry'])
  conditionType?: 'normal' | 'damaged' | 'near_expiry';

  @IsOptional()
  @IsDateString()
  soldExpiryDate?: string | null;
}

export class UpdateInternalUseDto {
  @IsOptional()
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsInt()
  purposeId?: number;

  @IsOptional()
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  status?: number;

  @IsOptional()
  @IsInt()
  createdById?: number;

  @IsOptional()
  @IsString()
  transDate?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateInternalUseDetailDto)
  internalUseDetails?: UpdateInternalUseDetailDto[];

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}
