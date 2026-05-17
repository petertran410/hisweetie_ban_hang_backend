import {
  IsArray,
  ValidateNested,
  IsString,
  IsNumber,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SupplierBalanceAdjustmentRow {
  @IsString()
  supplierCode: string;

  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  transDate?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  supplierName?: string;
}

export class ImportSupplierBalanceAdjustmentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierBalanceAdjustmentRow)
  rows: SupplierBalanceAdjustmentRow[];
}
