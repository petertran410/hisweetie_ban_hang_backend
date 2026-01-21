import {
  IsOptional,
  IsInt,
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

class UpdateDestructionDetailDto {
  @IsInt()
  productId: number;

  @IsString()
  productName: string;

  @IsString()
  productCode: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;
}

export class UpdateDestructionDto {
  @IsOptional()
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  status?: number;

  @IsOptional()
  @IsInt()
  createdById?: number;

  @IsOptional()
  @IsString()
  destructionDate?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateDestructionDetailDto)
  destructionDetails?: UpdateDestructionDetailDto[];

  @IsOptional()
  isDraft?: boolean;
}
