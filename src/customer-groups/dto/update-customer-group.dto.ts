import { IsString, IsOptional } from 'class-validator';

export class UpdateCustomerGroupDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
