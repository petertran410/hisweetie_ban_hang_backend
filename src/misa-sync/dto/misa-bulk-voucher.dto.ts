import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Thông tin người mua ghi đè (nhập tay trên giao diện hóa đơn VAT).
 * Chỉ được áp dụng khi CẢ 3 trường đều có giá trị (xem MisaVoucherService).
 */
export class MisaBuyerOverrideDto {
  @IsOptional()
  @IsString()
  taxCode?: string;

  @IsOptional()
  @IsString()
  buyerName?: string;

  @IsOptional()
  @IsString()
  buyerAddress?: string;
}

/**
 * Body cho endpoint đẩy 1 hóa đơn lên Misa (cho phép gửi kèm override người mua).
 */
export class MisaCreateVoucherRequestDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MisaBuyerOverrideDto)
  buyerOverride?: MisaBuyerOverrideDto;

  /**
   * Đẩy lại (force) ngay cả khi hóa đơn đã SYNCED / đã có misaOrgRefId.
   * Dùng khi chứng từ trên Misa bị xóa và cần tạo lại với cùng orgRefId.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/**
 * Body cho endpoint đẩy hàng loạt hóa đơn lên Misa.
 */
export class MisaBulkVoucherRequestDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  invoiceCodes: string[];

  /**
   * Override người mua theo từng mã hóa đơn (tùy chọn).
   * Key = invoiceCode, value = thông tin ghi đè.
   */
  @IsOptional()
  buyerOverrides?: Record<string, MisaBuyerOverrideDto>;

  /**
   * Đẩy lại (force) toàn bộ hóa đơn trong danh sách kể cả đã SYNCED.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
