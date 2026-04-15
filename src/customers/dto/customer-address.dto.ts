import {
  IsString,
  IsBoolean,
  IsOptional,
  IsEmail,
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

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  receiver?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

  // ── Địa chỉ cũ (3 cấp - trước sáp nhập)
  // Bắt buộc có cityCode khi không có newCityCode (ít nhất 1 trong 2 loại địa chỉ)
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

  // ── Địa chỉ mới (2 cấp - sau sáp nhập)
  @IsOptional() @IsString() newCityCode?: string;
  @IsOptional() @IsString() newCityName?: string;
  @IsOptional() @IsString() newWardCode?: string;
  @IsOptional() @IsString() newWardName?: string;

  @IsOptional() @IsString() locationName?: string;

  // ── Thông tin xuất hóa đơn theo từng địa chỉ
  @IsOptional() @IsString() invoiceBuyerName?: string;
  @IsOptional() @IsString() invoiceAddress?: string;
  @IsOptional() @IsString() invoiceCityCode?: string;
  @IsOptional() @IsString() invoiceCityName?: string;
  @IsOptional() @IsString() invoiceWardCode?: string;
  @IsOptional() @IsString() invoiceWardName?: string;
  @IsOptional() @IsString() invoiceCccdCmnd?: string;
  @IsOptional() @IsString() invoiceBankAccount?: string;

  // Chỉ validate email khi có giá trị thực (tránh fail khi gửi chuỗi rỗng)
  @ValidateIf((o) => o.invoiceEmail !== undefined && o.invoiceEmail !== '')
  @IsEmail({}, { message: 'Email xuất hóa đơn không hợp lệ' })
  invoiceEmail?: string;

  @IsOptional() @IsString() invoicePhone?: string;
  @IsOptional() @IsString() invoiceDvqhnsCode?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
