import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PublicRecipeQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['SEMI_FINISHED', 'FINISHED_PRODUCT'])
  type?: 'SEMI_FINISHED' | 'FINISHED_PRODUCT';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @IsOptional()
  @IsIn(['newest', 'name', 'cost'])
  sort: 'newest' | 'name' | 'cost' = 'newest';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit = 12;
}

export class PublicRecipePdfQueryDto {
  @IsOptional()
  @IsIn(['full', 'guide'])
  variant: 'full' | 'guide' = 'full';
}
