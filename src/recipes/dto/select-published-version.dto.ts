import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class SelectPublishedVersionDto {
  @IsInt()
  @Min(1)
  versionId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeNote?: string;
}
