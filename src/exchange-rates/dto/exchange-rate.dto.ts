import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Query DTO cho `GET /api/exchange-rates/latest`.
 *
 * - `base`   : tiền tệ gốc (ISO 4217). Mặc định `CNY` — đáp ứng use case chính
 *              của hệ thống (nhập hàng từ Trung Quốc).
 * - `symbols`: tiền tệ đích, phân cách bằng dấu phẩy nếu nhiều. Mặc định `VND`.
 *
 * Ví dụ: `?base=CNY&symbols=VND`.
 */
export class GetExchangeRateDto {
  @ApiProperty({
    required: false,
    default: 'CNY',
    description: 'Mã tiền tệ gốc (ISO 4217). Mặc định CNY.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['CNY', 'USD', 'EUR', 'JPY', 'VND'])
  base?: string;

  @ApiProperty({
    required: false,
    default: 'VND',
    description:
      'Mã tiền tệ đích (ISO 4217), phân cách phẩy nếu nhiều. Mặc định VND.',
  })
  @IsOptional()
  @IsString()
  symbols?: string;
}

/**
 * Body DTO cho `POST /api/exchange-rates/refresh` — ép buộc gọi API bên ngoài
 * bỏ qua cache (dùng khi user ấn nút "Cập nhật tỉ giá" trên form).
 */
export class RefreshExchangeRateDto {
  @ApiProperty({
    required: false,
    default: 'CNY',
    description: 'Mã tiền tệ gốc (ISO 4217). Mặc định CNY.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['CNY', 'USD', 'EUR', 'JPY', 'VND'])
  base?: string;

  @ApiProperty({
    required: false,
    default: 'VND',
    description: 'Mã tiền tệ đích (ISO 4217). Mặc định VND.',
  })
  @IsOptional()
  @IsString()
  symbols?: string;
}
