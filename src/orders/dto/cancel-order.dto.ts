import { IsBoolean, IsOptional } from 'class-validator';

export class CancelOrderDto {
  @IsBoolean()
  @IsOptional()
  cancelPayments?: boolean;
}
