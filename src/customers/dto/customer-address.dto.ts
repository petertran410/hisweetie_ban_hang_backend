import {
  IsString,
  IsBoolean,
  IsOptional,
  IsInt,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CustomerAddressDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  id?: number;

  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() receiver?: string;
  @IsOptional() @IsString() contactNumber?: string;
  @IsOptional() @IsString() address?: string;

  // ── Địa chỉ cũ (3 cấp)
  @ValidateIf((o) => !o.newCityCode)
  @IsNotEmpty({
    message: 'Phải có ít nhất 1 trong 2 loại địa chỉ (Tỉnh/Thành cũ hoặc mới)',
  })
  @IsString()
  cityCode?: string;

  @IsOptional() @IsString() cityName?: string;
  @IsOptional() @IsString() districtCode?: string;
  @IsOptional() @IsString() districtName?: string;
  @IsOptional() @IsString() wardCode?: string;
  @IsOptional() @IsString() wardName?: string;

  // ── Địa chỉ mới (2 cấp)
  @IsOptional() @IsString() newCityCode?: string;
  @IsOptional() @IsString() newCityName?: string;
  @IsOptional() @IsString() newWardCode?: string;
  @IsOptional() @IsString() newWardName?: string;

  @IsOptional() @IsString() locationName?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
