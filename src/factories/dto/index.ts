import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export class CreateFactoryDto {
  @IsOptional() @IsString() code?: string;
  @IsString() name: string;
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() strategicLevel?: string;
  @IsOptional() @IsString() wechat?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsNumber() @Min(0) moq?: number;
  @IsOptional() @IsInt() @Min(0) leadtimeDays?: number;
  @IsOptional() @IsString() paymentTerm?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() contactNumber?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsInt() @Transform(toInt) supplierId?: number;
  @IsOptional() @IsBoolean() @Transform(toBool) isActive?: boolean;
}

export class UpdateFactoryDto extends PartialType(CreateFactoryDto) {}

export class FactoryQueryDto {
  @IsOptional() @IsInt() @Transform(toInt) supplierId?: number;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsBoolean() @Transform(toBool) includeInactive?: boolean;
  @IsOptional() @IsInt() @Min(1) @Transform(toInt) page?: number;
  @IsOptional() @IsInt() @Min(1) @Transform(toInt) limit?: number;
  @IsOptional()
  @IsIn(['name', 'code', 'createdAt'])
  orderBy?: 'name' | 'code' | 'createdAt';
  @IsOptional()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';
}
