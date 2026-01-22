import { IsString, IsOptional, IsInt } from 'class-validator';

export class CreateSupplierGroupDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateSupplierGroupDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class ManageSuppliersDto {
  @IsInt({ each: true })
  supplierIds: number[];
}
