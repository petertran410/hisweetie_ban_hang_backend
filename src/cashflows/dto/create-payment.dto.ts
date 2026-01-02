import { IsInt, IsOptional, IsNumber, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePaymentDto {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;
}
