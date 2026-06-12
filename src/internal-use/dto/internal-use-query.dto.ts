import { IsOptional, IsInt, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class InternalUseQueryDto {
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
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  createdById?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  userId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  purposeId?: number;
}
