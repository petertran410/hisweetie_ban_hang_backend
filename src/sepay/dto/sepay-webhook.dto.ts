import { IsString, IsOptional, IsNumber, IsNotEmpty } from 'class-validator';

export class SepayWebhookDto {
  @IsNumber()
  @IsNotEmpty()
  id!: number;

  @IsString()
  @IsOptional()
  gateway?: string;

  @IsString()
  @IsOptional()
  transactionDate?: string;

  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsNotEmpty()
  transferType!: string; // 'in' | 'out'

  @IsNumber()
  @IsNotEmpty()
  transferAmount!: number;

  @IsNumber()
  @IsOptional()
  accumulated?: number;

  @IsString()
  @IsOptional()
  subAccount?: string | null;

  @IsString()
  @IsOptional()
  referenceCode?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
