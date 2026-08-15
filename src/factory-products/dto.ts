import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

const toNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export class FactoryProductQueryDto {
  @IsOptional() @IsInt() @Transform(toInt) factoryId?: number;
  @IsOptional() @IsInt() @Transform(toInt) productId?: number;
  @IsOptional() @IsIn(['primary', 'backup']) role?: 'primary' | 'backup';
  @IsOptional() @IsBoolean() @Transform(toBool) includeInactive?: boolean;
}

export class CreateFactoryProductDto {
  @IsInt() @Transform(toInt) factoryId: number;
  @IsInt() @Transform(toInt) productId: number;
  @IsOptional() @IsIn(['primary', 'backup']) role?: 'primary' | 'backup';
  @IsOptional() @IsInt() @Min(0) @Transform(toInt) priority?: number;
  @IsOptional() @IsNumber() @Min(0) @Transform(toNumber) referencePrice?:
    | number
    | null;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Min(0) @Transform(toNumber) exchangeRate?:
    | number
    | null;
  @IsOptional() @IsBoolean() @Transform(toBool) isManualRate?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Transform(toNumber) moq?: number | null;
  @IsOptional() @IsInt() @Min(0) @Transform(toInt) leadtimeDays?: number | null;
  @IsOptional() @IsString() note?: string | null;
  @IsOptional() @IsBoolean() @Transform(toBool) isActive?: boolean;
  @IsOptional() @IsString() reason?: string;
}

export class UpdateFactoryProductDto extends PartialType(
  CreateFactoryProductDto,
) {}

export class PriceHistorySeriesQueryDto {
  @IsInt() @Min(1) @Transform(toInt) productId: number;
  @IsOptional() @IsString() factoryIds?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['native', 'vnd']) currencyMode?: 'native' | 'vnd';
  @IsOptional() @IsIn(['reference', 'purchase_order']) eventType?:
    | 'reference'
    | 'purchase_order';
  @IsOptional() @IsInt() @Min(1) @Transform(toInt) page?: number;
  @IsOptional() @IsInt() @Min(1) @Transform(toInt) limit?: number;
}

export class ReferencePricesQueryDto {
  @IsString() productIds: string;
  @IsOptional() @IsInt() @Transform(toInt) supplierId?: number;
  @IsOptional() @IsInt() @Transform(toInt) factoryId?: number;
}
