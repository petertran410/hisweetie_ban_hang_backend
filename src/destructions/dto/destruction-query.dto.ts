import { IsOptional, IsInt, IsString, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class DestructionQueryDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  branchIds?: number[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
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
