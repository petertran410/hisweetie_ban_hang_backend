import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsDateString,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CustomerQueryDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  contactNumber?: string;

  @IsOptional()
  @IsDateString()
  lastModifiedFrom?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number;

  @IsOptional()
  @IsString()
  orderBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeRemoveIds?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeTotal?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeCustomerGroup?: boolean;

  @IsOptional()
  @IsString()
  birthDate?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  groupId?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeCustomerSocial?: boolean;

  // Extended filters
  @IsOptional()
  @IsString()
  @IsIn(['all', 'individual', 'company'])
  customerType?: 'all' | 'individual' | 'company';

  @IsOptional()
  @IsString()
  @IsIn(['all', 'male', 'female'])
  gender?: 'all' | 'male' | 'female';

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  createdBy?: number;

  @IsOptional()
  @IsDateString()
  createdDateFrom?: string;

  @IsOptional()
  @IsDateString()
  createdDateTo?: string;

  @IsOptional()
  @IsDateString()
  birthdayFrom?: string;

  @IsOptional()
  @IsDateString()
  birthdayTo?: string;

  @IsOptional()
  @IsDateString()
  lastTransactionFrom?: string;

  @IsOptional()
  @IsDateString()
  lastTransactionTo?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  totalPurchasedFrom?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  totalPurchasedTo?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  debtFrom?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  debtTo?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  debtDaysFrom?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  debtDaysTo?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pointFrom?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pointTo?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  isActive?: boolean;
}
