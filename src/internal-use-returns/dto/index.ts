import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export const INTERNAL_USE_RETURN_STATUS = {
  REQUEST: 1,
  STOCK_RECEIVED: 2,
  CANCELLED: 3,
  REQUEST_DRAFT: 4,
  STOCK_DRAFT: 5,
} as const;

export const INTERNAL_USE_RETURN_STATUS_LABELS: Record<number, string> = {
  [INTERNAL_USE_RETURN_STATUS.REQUEST]: 'Chờ nhận hàng',
  [INTERNAL_USE_RETURN_STATUS.STOCK_RECEIVED]: 'Đã nhập lại kho',
  [INTERNAL_USE_RETURN_STATUS.CANCELLED]: 'Đã hủy',
  [INTERNAL_USE_RETURN_STATUS.REQUEST_DRAFT]: 'Phiếu tạm',
  [INTERNAL_USE_RETURN_STATUS.STOCK_DRAFT]: 'Đang nhập hàng (tạm)',
};

export type InternalUseReturnCondition =
  | 'normal'
  | 'damaged'
  | 'near_expiry';

export class InternalUseReturnDetailDto {
  @IsInt()
  internalUseDetailId: number;

  @IsNumber()
  @Min(0.01)
  requestQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateInternalUseReturnDto {
  @IsInt()
  internalUseId: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalUseReturnDetailDto)
  details: InternalUseReturnDetailDto[];
}

export class UpdateInternalUseReturnDetailDto {
  @IsInt()
  detailId: number;

  @IsNumber()
  @Min(0.01)
  requestQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateInternalUseReturnDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateInternalUseReturnDetailDto)
  details: UpdateInternalUseReturnDetailDto[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}

export class ConfirmInternalUseReturnDetailDto {
  @IsInt()
  detailId: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  confirmedQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  goodQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  damagedQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  nearExpiryQuantity?: number;

  @IsOptional()
  @IsDateString()
  nearExpiryDate?: string | null;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ConfirmInternalUseReturnDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmInternalUseReturnDetailDto)
  details: ConfirmInternalUseReturnDetailDto[];

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;
}

export class InternalUseReturnQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  internalUseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;
}

