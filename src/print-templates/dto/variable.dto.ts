import { IsString, IsOptional, IsBoolean, IsInt } from 'class-validator';

export class CreateVariableDto {
  @IsString()
  templateFor: string;

  @IsString()
  key: string;

  @IsString()
  label: string;

  @IsString()
  group: string;

  @IsString()
  @IsOptional()
  dataType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateVariableDto {
  @IsString()
  @IsOptional()
  label?: string;

  @IsString()
  @IsOptional()
  group?: string;

  @IsString()
  @IsOptional()
  dataType?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
