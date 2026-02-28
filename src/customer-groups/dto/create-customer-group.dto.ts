import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
} from 'class-validator';

export class CreateCustomerGroupDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsArray()
  allowedUserIds?: number[];

  @IsOptional()
  autoAddConditions?: Array<{
    field: string;
    operator: string;
    value: string | number;
  }>;

  @IsOptional()
  @IsIn(['add_by_condition', 'refresh_by_condition', 'no_update'])
  autoUpdateMode?: string;

  @IsOptional()
  @IsBoolean()
  autoExecute?: boolean;
}

export class UpdateCustomerGroupDto extends CreateCustomerGroupDto {}
