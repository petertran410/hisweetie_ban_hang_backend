import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class PriceBookQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;
}

export class ApplicablePriceBooksDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;

  @IsOptional()
  @IsString()
  date?: string;
}

export class ProductPriceDto {
  @IsNumber()
  @Type(() => Number)
  productId: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  customerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;
}

export class ProductsWithPricesQueryDto {
  @Transform(({ value }) => {
    console.log('Transform priceBookIds - Raw value:', value);
    console.log('Transform priceBookIds - Type:', typeof value);

    if (Array.isArray(value)) {
      return value
        .map((id) => parseInt(String(id), 10))
        .filter((id) => !isNaN(id) && id > 0);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id) && id > 0);
    }

    if (typeof value === 'number') {
      return [value];
    }

    console.warn(
      'priceBookIds transform received unexpected type:',
      typeof value,
    );
    return [];
  })
  @IsArray()
  @Type(() => Number)
  priceBookIds: number[];

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value && value.trim() !== '' ? value : undefined))
  search?: string;

  @IsOptional()
  @Type(() => Number)
  categoryId?: number;
}
