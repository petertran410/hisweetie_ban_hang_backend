import { IsInt, IsOptional, IsString } from 'class-validator';

export class UpdatePurposeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  order?: number;
}
