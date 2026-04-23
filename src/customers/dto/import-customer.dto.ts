import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ImportCustomerRowDto {
  @IsOptional() @IsString() code?: string;
  @IsString() name: string;
  @IsOptional() @IsString() contactNumber?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() birthDate?: string;
  @IsOptional() @IsString() gender?: string; // "Nam" | "Nữ"
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() locationName?: string;
  @IsOptional() @IsString() wardName?: string;
  @IsOptional() @IsString() organization?: string;
  @IsOptional() @IsString() taxCode?: string;
  @IsOptional() @IsString() groups?: string; // "VIP, Đại lý"
  @IsOptional() @IsString() comments?: string;
  @IsOptional() @IsNumber() totalDebt?: number;
}

export class ImportCustomersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  rows: ImportCustomerRowDto[];

  @IsOptional()
  @IsBoolean()
  updateDebt?: boolean;
}
