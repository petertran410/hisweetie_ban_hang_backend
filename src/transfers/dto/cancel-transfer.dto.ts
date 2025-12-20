import { IsOptional, IsString } from 'class-validator';

export class CancelTransferDto {
  @IsOptional()
  @IsString()
  cancelReason?: string;
}
