import { IsInt, IsString, IsOptional, IsArray } from 'class-validator';

export class CreatePackingLoadingDto {
  @IsInt()
  branchId: number;

  @IsInt()
  loadingById: number;

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

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  imageUrls?: string[];
}
