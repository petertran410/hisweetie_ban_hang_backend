import {
  IsInt,
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
} from 'class-validator';

export class CreatePackingSlipDto {
  @IsInt()
  branchId: number;

  @IsArray()
  @IsInt({ each: true })
  invoiceIds: number[];

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

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];
}
