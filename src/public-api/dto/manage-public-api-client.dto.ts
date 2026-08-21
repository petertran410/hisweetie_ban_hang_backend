import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePublicApiClientDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Giây. OAuth token phải đủ ngắn để deactivate/rotate có hiệu lực sớm. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300)
  @Max(86400)
  accessTokenTtl?: number;
}

export class UpdatePublicApiClientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300)
  @Max(86400)
  accessTokenTtl?: number;
}
