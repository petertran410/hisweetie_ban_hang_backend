import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

export class RunBacktestDto {
  @IsOptional()
  @IsDateString()
  snapshotDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(6)
  @Max(24)
  minTrainingMonths = 12;
}
