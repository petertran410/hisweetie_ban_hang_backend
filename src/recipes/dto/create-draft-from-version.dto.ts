import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateDraftFromVersionDto {
  @IsInt()
  @Min(1)
  sourceVersionId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeNote?: string;
}
