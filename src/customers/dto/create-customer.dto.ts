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
  ValidateIf,
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
  @IsOptional() @IsString() invoiceBuyerName?: string;
  @IsOptional() @IsString() invoiceAddress?: string;
  @IsOptional() @IsString() invoiceCityCode?: string;
  @IsOptional() @IsString() invoiceCityName?: string;
  @IsOptional() @IsString() invoiceWardCode?: string;
  @IsOptional() @IsString() invoiceWardName?: string;
  @IsOptional() @IsString() invoiceCccdCmnd?: string;
  @IsOptional() @IsString() invoiceBankAccount?: string;
  @ValidateIf((o) => o.invoiceEmail !== undefined && o.invoiceEmail !== '')
  @IsEmail({}, { message: 'Email xuất hóa đơn không hợp lệ' })
  invoiceEmail?: string;
  @IsOptional() @IsString() invoicePhone?: string;
  @IsOptional() @IsString() invoiceDvqhnsCode?: string;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];
  @IsOptional() @IsNumber() @Type(() => Number) branchId?: number;
  @IsOptional() @IsInt() @Type(() => Number) parentId?: number;
  @IsArray()
  @ArrayMinSize(1, { message: 'Phải có ít nhất 1 địa chỉ giao hàng' })
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses: CustomerAddressDto[];
}
