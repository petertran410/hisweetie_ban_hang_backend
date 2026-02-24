import { IsInt, IsString, IsOptional, IsArray } from 'class-validator';

export class CreatePackingHangDto {
  @IsInt()
  branchId: number;

  @IsArray()
  @IsInt({ each: true })
  invoiceIds: number[];

  @IsInt()
  numberOfPackages: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];
}
