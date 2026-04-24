import { IsBoolean, IsInt, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class ImportProductsOptionsDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  updateStock?: boolean = false;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  updateDescription?: boolean = false;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  updateCost?: boolean = false;

  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  branchId?: number;
}
