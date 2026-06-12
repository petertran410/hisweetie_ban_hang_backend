import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreatePurposeDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsInt()
  order?: number;
}
