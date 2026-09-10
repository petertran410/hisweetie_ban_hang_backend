import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const CUSTOMER_DEMAND_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'CANCELLED',
] as const;
export const CUSTOMER_DEMAND_UNITS = ['BASE', 'CARTON'] as const;

export class CustomerDemandLineDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  productId!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  quantity!: number;

  @IsIn(CUSTOMER_DEMAND_UNITS)
  unit!: (typeof CUSTOMER_DEMAND_UNITS)[number];
}

export class CustomerDemandMonthDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  id?: number;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CustomerDemandLineDto)
  lines!: CustomerDemandLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeNote?: string;
}

export class CreateCustomerDemandDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  customerId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CustomerDemandMonthDto)
  months!: CustomerDemandMonthDto[];
}

export class UpdateCustomerDemandDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  customerId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CustomerDemandMonthDto)
  months!: CustomerDemandMonthDto[];
}

export class CustomerDemandQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  customerId?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @IsOptional()
  @IsIn(CUSTOMER_DEMAND_STATUSES)
  status?: (typeof CUSTOMER_DEMAND_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CustomerDemandMonthActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
