import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateCustomerDto } from './create-customer.dto';
import { UpdateCustomerDto } from './update-customer.dto';

export class BulkCreateCustomerDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerDto)
  listCustomers: CreateCustomerDto[];
}

export class BulkUpdateCustomerDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateCustomerDto)
  listCustomers: (UpdateCustomerDto & { id: number })[];
}
