import {
  IsInt,
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNumber,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

class TransferDetailDto {
  @IsString()
  productCode: string;

  @IsInt()
  productId: number;

  @IsNumber()
  sendQuantity: number;

  @IsNumber()
  @IsOptional()
  receivedQuantity?: number;

  @IsNumber()
  price: number;
}

export class CreateTransferDto {
  @IsInt()
  fromBranchId: number;

  @IsInt()
  toBranchId: number;

  @IsBoolean()
  @IsOptional()
  isDraft?: boolean;

  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @IsOptional()
  status?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferDetailDto)
  transferDetails: TransferDetailDto[];
}
