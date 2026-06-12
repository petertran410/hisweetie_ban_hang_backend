import { IsOptional, IsString } from 'class-validator';

export class CancelInternalUseDto {
  @IsOptional()
  @IsString()
  cancelReason?: string;
}
