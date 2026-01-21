import { IsOptional, IsString } from 'class-validator';

export class CancelDestructionDto {
  @IsOptional()
  @IsString()
  cancelReason?: string;
}
