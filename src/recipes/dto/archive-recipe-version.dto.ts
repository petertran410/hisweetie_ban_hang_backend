import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ArchiveRecipeVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
