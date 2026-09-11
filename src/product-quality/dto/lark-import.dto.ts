import { IsOptional, IsString, IsBoolean, IsInt } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class LarkImportDto {
  @IsOptional()
  @IsString()
  baseToken?: string;

  @IsOptional()
  @IsString()
  tableId?: string;

  @IsOptional()
  @IsString()
  viewId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  downloadMedia?: boolean;
}
