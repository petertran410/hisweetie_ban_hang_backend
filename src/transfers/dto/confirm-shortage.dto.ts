import { IsArray, IsOptional, IsString } from 'class-validator';

export class ConfirmShortageDto {
  /**
   * Khi kho nhận nhận thiếu so với số lượng chuyển, hệ thống TỰ ĐỘNG hoàn
   * shortage về kho chuyển (cộng lại tồn kho kho chuyển đúng bằng số thiếu).
   *
   * DTO này chỉ chứa note tùy chọn — không cần client chỉ định resolution.
   * Để backward-compatible với frontend cũ, vẫn nhận shortageResolution
   * nếu có nhưng bỏ qua.
   */
  @IsOptional()
  @IsArray()
  shortageResolution?: unknown[];

  @IsOptional()
  @IsString()
  note?: string;
}