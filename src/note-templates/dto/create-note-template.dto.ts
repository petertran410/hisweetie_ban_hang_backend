import { IsString, IsOptional, IsBoolean, IsInt } from 'class-validator';

export class CreateNoteTemplateDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
