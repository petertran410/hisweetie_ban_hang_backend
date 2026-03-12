import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsInt,
} from 'class-validator';

export class CreateBankAccountDto {
  @IsString()
  @IsNotEmpty()
  accountNumber: string | undefined;

  @IsString()
  @IsNotEmpty()
  bankCode: string | undefined;

  @IsString()
  @IsNotEmpty()
  bankName: string | undefined;

  @IsString()
  @IsNotEmpty()
  accountHolder: string | undefined;

  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsNotEmpty()
  scope: string | undefined;

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  branchIds?: number[];
}
