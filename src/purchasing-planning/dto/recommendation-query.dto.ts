import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

const csv = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const values = Array.isArray(value) ? value : String(value).split(',');
  return values.map((item) => String(item).trim()).filter(Boolean);
};

const csvNumbers = ({ value }: { value: unknown }) => {
  const values = csv({ value });
  return values?.map(Number);
};

const booleanValue = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class RecommendationQueryDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'HEALTHY', 'OVERSTOCK', 'NO_DATA'],
    { each: true },
  )
  priority?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(['RELIABLE', 'CAUTION', 'UNRELIABLE', 'BLOCKED'], { each: true })
  reliability?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(['HIGH', 'MEDIUM', 'LOW', 'VERY_LOW', 'NO_DATA'], { each: true })
  confidence?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  parentNames?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  middleNames?: string[];

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  childNames?: string[];

  @IsOptional()
  @Transform(csvNumbers)
  @IsArray()
  @IsInt({ each: true })
  tradeMarkIds?: number[];

  @IsOptional()
  @Transform(csvNumbers)
  @IsArray()
  @IsInt({ each: true })
  supplierIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  daysUntilStockoutFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  daysUntilStockoutTo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  daysOfSupplyFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  daysOfSupplyTo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedValueFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedValueTo?: number;

  @IsOptional()
  @Transform(booleanValue)
  @IsBoolean()
  hasFlags?: boolean;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  flagCodes?: string[];

  @IsOptional()
  @Transform(booleanValue)
  @IsBoolean()
  isBlocked?: boolean;

  @IsOptional()
  @IsIn([
    'PENDING',
    'APPROVED',
    'ADJUSTED',
    'REJECTED',
    'ORDERED',
    'SUPERSEDED',
    'BLOCKED',
  ])
  status?: string;

  @IsOptional()
  @Transform(booleanValue)
  @IsBoolean()
  needsOrderOnly = true;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @IsIn([
    'priority',
    'stockout',
    'value',
    'gap',
    'code',
    'name',
    'supplier',
    'stock',
    'available',
    'incoming',
    'forecast',
    'dos',
    'rop',
    'position',
    'soq',
    'leadtime',
  ])
  sortBy = 'priority';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'asc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  supplierId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;
}
