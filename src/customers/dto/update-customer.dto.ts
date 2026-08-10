import {
  IsString,
  IsBoolean,
  IsOptional,
  IsDateString,
  IsEmail,
  IsArray,
  IsInt,
  IsNumber,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CustomerAddressDto } from './customer-address.dto';

export class UpdateCustomerDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
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
  // Misa: nhân viên phụ trách (account object có isEmployee = true)
  @IsOptional() @IsString() misaEmployeeId?: string;
  @IsOptional() @IsString() misaEmployeeCode?: string;
  @IsOptional() @IsString() misaEmployeeName?: string;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];
  @IsOptional() @IsNumber() @Type(() => Number) branchId?: number;
  @IsOptional() @IsInt() @Type(() => Number) parentId?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses?: CustomerAddressDto[];
}
