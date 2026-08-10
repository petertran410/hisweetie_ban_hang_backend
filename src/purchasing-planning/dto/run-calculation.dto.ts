import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class RunCalculationDto {
  @IsOptional()
  @IsIn(['DAILY', 'MANUAL'])
  runType: 'DAILY' | 'MANUAL' = 'MANUAL';

  @IsOptional()
  @IsDateString()
  snapshotDate?: string;
}
