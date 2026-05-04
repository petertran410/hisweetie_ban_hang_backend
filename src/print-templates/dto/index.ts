import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class GetVariablesDto {
  @IsString()
  @IsNotEmpty()
  templateFor: string;
}

export class RenderPreviewDto {
  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  templateId: number;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  entityId: number;

  @IsString()
  @IsOptional()
  entityType?: string;
}
