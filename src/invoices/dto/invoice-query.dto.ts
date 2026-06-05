import {
  IsOptional,
  IsInt,
  IsString,
  IsDateString,
  IsArray,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class InvoiceQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  currentItem?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (typeof value === 'string') return value.split(',').map(Number);
    if (Array.isArray(value)) return value.map(Number);
    return value;
  })
  customerIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : [],
  )
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  parentCustomerId?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    if (typeof value === 'number') return [value];
    return value;
  })
  @IsArray()
  @IsInt({ each: true })
  statusIds?: number[];

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['none', 'pending', 'delivered'])
  deliveryStatus?: 'none' | 'pending' | 'delivered';

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map(Number) : value,
  )
  bankAccountIds?: number[];

  @IsOptional()
  @IsDateString()
  fromPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  toPurchaseDate?: string;

  @IsOptional()
  @IsDateString()
  fromCreatedDate?: string;

  @IsOptional()
  @IsDateString()
  toCreatedDate?: string;

  @IsOptional()
  @IsString()
  invoiceCodeSearch?: string;

  @IsOptional()
  @IsString()
  productSearch?: string;

  @IsOptional()
  @IsString()
  customerSearch?: string;

  @IsOptional()
  @IsString()
  @IsIn([
    'purchaseDate',
    'createdAt',
    'updatedAt',
    'grandTotal',
    'paidAmount',
    'returnOrderAmount',
    'cashRefundAmount',
    'debtOffsetAmount',
    'remainingAmount',
  ])
  orderBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: string;

  @IsOptional()
  @IsString()
  deliveryCodeSearch?: string;

  @IsOptional()
  @IsString()
  orderCodeSearch?: string;

  @IsOptional()
  @IsString()
  descriptionSearch?: string;

  @IsOptional()
  @IsString()
  productNoteSearch?: string;

  @IsOptional()
  @IsString()
  columns?: string;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : value !== undefined
          ? [Number(value)]
          : undefined,
  )
  @IsArray()
  @IsInt({ each: true })
  createdByIds?: number[];

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map(Number)
      : typeof value === 'string'
        ? value.split(',').map(Number).filter(Boolean)
        : value !== undefined
          ? [Number(value)]
          : undefined,
  )
  @IsArray()
  @IsInt({ each: true })
  soldByIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  saleChannelId?: number;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value,
  )
  @IsArray()
  @IsIn(['PENDING', 'SYNCED', 'FAILED', 'SKIP'], { each: true })
  misaSyncStatus?: ('PENDING' | 'SYNCED' | 'FAILED' | 'SKIP')[];

  // Lọc theo nhân viên phụ trách (Misa) — khớp customer.misaEmployeeCode
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value,
  )
  @IsArray()
  @IsString({ each: true })
  misaEmployeeCodes?: string[];

  // Lọc theo trạng thái mã số thuế của khách hàng:
  // 'empty' = trống cả taxCode lẫn identificationNumber,
  // 'filled' = có ít nhất một trong hai.
  @IsOptional()
  @IsString()
  @IsIn(['empty', 'filled'])
  taxCodeStatus?: 'empty' | 'filled';
}
