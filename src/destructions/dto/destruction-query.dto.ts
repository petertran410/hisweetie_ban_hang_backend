import { IsOptional, IsInt, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class DestructionQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  branchIds?: number[];

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  status?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number;

  @IsOptional()
  @IsString()
  fromDestructionDate?: string;

  @IsOptional()
  @IsString()
  toDestructionDate?: string;
}
