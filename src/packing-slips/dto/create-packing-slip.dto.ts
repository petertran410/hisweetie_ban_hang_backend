import {
  IsInt,
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PackingSlipExpenseFileDto {
  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  @IsInt()
  fileSize?: number;
}

export class CreatePackingSlipDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  invoiceIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  consignmentIds?: number[];

  @IsInt()
  numberOfPackages: number;

  @IsString()
  paymentMethod: string;

  @IsOptional()
  @IsNumber()
  cashAmount?: number;

  @IsBoolean()
  hasFeeGuiBen: boolean;

  @IsOptional()
  @IsNumber()
  feeGuiBen?: number;

  @IsBoolean()
  hasFeeGrab: boolean;

  @IsOptional()
  @IsNumber()
  feeGrab?: number;

  @IsBoolean()
  hasCuocGuiHang: boolean;

  @IsOptional()
  @IsNumber()
  cuocGuiHang?: number;

  @IsBoolean()
  hasCuocNhanHang: boolean;

  @IsOptional()
  @IsNumber()
  cuocNhanHang?: number;

  @IsOptional()
  @IsInt()
  expensePayerId?: number | null;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PackingSlipExpenseFileDto)
  expenseFiles?: PackingSlipExpenseFileDto[];
}
