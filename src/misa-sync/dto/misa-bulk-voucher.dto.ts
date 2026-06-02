import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * Body cho endpoint đẩy hàng loạt hóa đơn lên Misa.
 */
export class MisaBulkVoucherRequestDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  invoiceCodes: string[];
}
