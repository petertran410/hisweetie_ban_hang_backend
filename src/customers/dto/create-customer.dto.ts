import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsDateString,
  IsEmail,
  IsArray,
  IsInt,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CustomerAddressDto } from './customer-address.dto';

export class CreateCustomerDto {
  @IsOptional() @IsString() code?: string;

  @IsString() name: string;

  @IsOptional() @IsBoolean() gender?: boolean;
  @IsOptional() @IsDateString() birthDate?: string;
  @IsOptional() @IsString() contactNumber?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;

  @IsOptional() @IsInt() @Type(() => Number) type?: number;

  @IsOptional() @IsString() organization?: string;
  @IsOptional() @IsString() taxCode?: string;
  @IsOptional() @IsString() comments?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];

  @IsOptional() @IsNumber() @Type(() => Number) branchId?: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'Phải có ít nhất 1 địa chỉ giao hàng' })
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses: CustomerAddressDto[];
}
