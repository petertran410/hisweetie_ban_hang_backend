import { IsOptional, IsInt, IsString } from 'class-validator';

export class PackingSlipQueryDto {
  @IsOptional()
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @IsInt()
  currentItem?: number;
}
