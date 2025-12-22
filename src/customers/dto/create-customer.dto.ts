import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsDateString,
  IsEmail,
  IsArray,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCustomerDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  gender?: boolean;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  facebook?: string;

  @IsOptional()
  @IsString()
  zalo?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  cityCode?: string;

  @IsOptional()
  @IsString()
  cityName?: string;

  @IsOptional()
  @IsString()
  districtCode?: string;

  @IsOptional()
  @IsString()
  districtName?: string;

  @IsOptional()
  @IsString()
  wardCode?: string;

  @IsOptional()
  @IsString()
  wardName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  type?: number;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsOptional()
  @IsString()
  taxCode?: string;

  @IsOptional()
  @IsString()
  invoiceBuyerName?: string;

  @IsOptional()
  @IsString()
  invoiceCityCode?: string;

  @IsOptional()
  @IsString()
  invoiceCityName?: string;

  @IsOptional()
  @IsString()
  invoiceWardCode?: string;

  @IsOptional()
  @IsString()
  invoiceWardName?: string;

  @IsOptional()
  @IsString()
  invoiceAddress?: string;

  @IsOptional()
  @IsString()
  invoiceCccdCmnd?: string;

  @IsOptional()
  @IsString()
  invoiceBankAccount?: string;

  @IsOptional()
  @IsEmail()
  invoiceEmail?: string;

  @IsOptional()
  @IsString()
  invoicePhone?: string;

  @IsOptional()
  @IsString()
  invoiceDvqhnsCode?: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;
}
