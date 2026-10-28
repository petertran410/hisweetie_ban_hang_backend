import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UnitQueryDto {
  // true → gồm cả đơn vị đang ẩn (trang quản lý); mặc định chỉ đơn vị đang dùng.
  @IsOptional()
  @Type(() => String)
  includeInactive?: string;
}

export class CreateUnitDto {
  @IsString()
  @MaxLength(50)
  name: string;
}

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Đổi tên trùng một đơn vị khác = gộp; phải xác nhận rõ.
  @IsOptional()
  @IsBoolean()
  confirmMerge?: boolean;
}

export class ReorderUnitsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Type(() => Number)
  ids: number[];
}
