import { PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

const toNum = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export class CreateFactoryProductDto {
  @IsInt() @Transform(toInt) factoryId: number;
  @IsInt() @Transform(toInt) productId: number;

  @IsOptional() @IsIn(['primary', 'backup']) role?: 'primary' | 'backup';
  @IsOptional() @IsInt() @Transform(toInt) priority?: number;

  @IsOptional() @IsNumber() @Transform(toNum) referencePrice?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Transform(toNum) exchangeRate?: number;
  @IsOptional() @IsBoolean() @Transform(toBool) isManualRate?: boolean;

  @IsOptional() @IsNumber() @Transform(toNum) moq?: number;
  @IsOptional() @IsInt() @Transform(toInt) leadtimeDays?: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsBoolean() @Transform(toBool) isActive?: boolean;

  /// Lý do đổi giá (ghi vào history). Không bắt buộc.
  @IsOptional() @IsString() reason?: string;
}

export class UpdateFactoryProductDto extends PartialType(
  CreateFactoryProductDto,
) {}

export class FactoryProductQueryDto {
  @IsOptional() @IsInt() @Transform(toInt) factoryId?: number;
  @IsOptional() @IsInt() @Transform(toInt) productId?: number;
  @IsOptional() @IsIn(['primary', 'backup']) role?: 'primary' | 'backup';
  @IsOptional() @IsBoolean() @Transform(toBool) includeInactive?: boolean;
}

export class ReferencePricesQueryDto {
  @IsOptional() @IsInt() @Transform(toInt) supplierId?: number;
  @IsOptional() @IsInt() @Transform(toInt) factoryId?: number;
  @IsArray()
  @IsInt({ each: true })
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map((v) => Number(v));
    if (typeof value === 'string' && value.length)
      return value.split(',').map((v) => Number(v.trim()));
    return [];
  })
  productIds: number[];
}
