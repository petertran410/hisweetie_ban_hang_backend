import {
  IsArray,
  ValidateNested,
  IsString,
  IsNumber,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BalanceAdjustmentRow {
  @IsString()
  contactNumber: string;

  @IsString()
  code: string;

  @IsOptional()
  @IsString()
  transDate?: string;

  @IsNumber()
  amount: number;
}

export class ImportBalanceAdjustmentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BalanceAdjustmentRow)
  rows: BalanceAdjustmentRow[];
}
