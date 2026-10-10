import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VEHICLE_FUEL_TYPES, VEHICLE_TYPES } from '../vehicles.constants';

export class VehicleQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsIn(['true', 'false'])
  includeInactive?: string;
}

export class CreateVehicleDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsString()
  @MaxLength(128)
  label: string;

  @IsString()
  @MaxLength(64)
  plate: string;

  @IsOptional()
  @IsIn(VEHICLE_TYPES)
  vehicleType?: string;

  @IsOptional()
  @IsIn(VEHICLE_FUEL_TYPES)
  fuelType?: string | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  driverId?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPerKmMin?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPerKmMax?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  oilChangeIntervalKm?: number | null;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  plate?: string;

  @IsOptional()
  @IsIn(VEHICLE_TYPES)
  vehicleType?: string;

  @IsOptional()
  @IsIn(VEHICLE_FUEL_TYPES)
  fuelType?: string | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  driverId?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPerKmMin?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPerKmMax?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  oilChangeIntervalKm?: number | null;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
