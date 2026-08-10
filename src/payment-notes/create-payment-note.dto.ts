import { IsIn, IsNumber, IsOptional, Min } from 'class-validator';

export class CreatePaymentNoteDto {
  @IsIn(['cash', 'transfer'])
  paymentType: 'cash' | 'transfer';

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}
