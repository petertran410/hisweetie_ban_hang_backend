import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsInt,
  IsBoolean,
} from 'class-validator';

export class CreateBankAccountDto {
  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  bankCode!: string;

  @IsString()
  @IsNotEmpty()
  bankName!: string;

  @IsString()
  @IsNotEmpty()
  accountHolder!: string;

  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsNotEmpty()
  scope!: string;

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  branchIds?: number[];

  /** Tài khoản nhận tiền mặt quỹ nội bộ Văn phòng SG (không phải tiền khách). */
  @IsBoolean()
  @IsOptional()
  vpsgCashFund?: boolean;
}
