import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_DIRECTION,
  INTERNAL_FINANCE_REVIEW_DECISION,
  WAREHOUSE_EXPENSE_ITEMS,
} from '../internal-finance.constants';
import { VEHICLE_SERVICE_TYPES } from '../../vehicles/vehicles.constants';

export class InternalFinanceAttachmentDto {
  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;

  @IsOptional()
  @IsString()
  kind?: string;
}

export class InternalFinanceQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item));
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) =>
        String(item)
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((part) => Number.isFinite(part)),
      );
    }
    return value;
  })
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @IsString()
  direction?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  subCategory?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  accountantStatus?: string;

  @IsOptional()
  @IsString()
  managerStatus?: string;

  @IsOptional()
  @IsString()
  weeklyApprovalStatus?: string;

  @IsOptional()
  @IsIn(['POSTED', 'UNPOSTED'])
  posted?: string;

  @IsOptional()
  @IsIn(['ISSUED', 'NOT_ISSUED'])
  cashIssued?: string;

  @IsOptional()
  @IsString()
  evidenceStatus?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['OPEN', 'POSTED', 'CANCELLED'])
  receiptStatus?: string;

  /** Tiền mặt kho: lọc theo xác nhận của kế toán kho. */
  @IsOptional()
  @IsIn(['UNCONFIRMED', 'CONFIRMED', 'DIFFERENT'])
  confirmStatus?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit = 50;
}

export class CreateManualReceiptDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  occurredAt: string;

  @IsIn(['cash', 'transfer'])
  method: string;

  @IsOptional()
  @IsString()
  cashSource?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  customerId?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  invoiceIds?: number[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  sourceSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class CreateManualExpenseDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsIn([
    INTERNAL_FINANCE_CATEGORY.SALARY_ADVANCE,
    INTERNAL_FINANCE_CATEGORY.OTHER_EXPENSE,
  ])
  category: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  occurredAt: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsObject()
  sourceSnapshot?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class CreateFuelEntryDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsInt()
  @Type(() => Number)
  vehicleId: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  liters?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  odo?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class CreateVehicleCareEntryDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsInt()
  @Type(() => Number)
  vehicleId: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(VEHICLE_SERVICE_TYPES, { each: true })
  serviceTypes: string[];

  @IsOptional()
  @IsString()
  location?: string;

  @IsDateString()
  occurredAt: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  odo?: number;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class UpdateVehicleEntryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  vehicleId?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(VEHICLE_SERVICE_TYPES, { each: true })
  serviceTypes?: string[];

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  liters?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  odo?: number | null;

  @IsOptional()
  @IsDateString()
  dueAt?: string | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class VehicleEntryQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsIn([
    INTERNAL_FINANCE_CATEGORY.FUEL,
    INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE,
  ])
  category: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  vehicleId?: number;

  @IsOptional()
  @IsIn(VEHICLE_SERVICE_TYPES)
  serviceType?: string;

  @IsOptional()
  @IsIn(['NORMAL', 'ABNORMAL'])
  check?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit = 50;
}

export class ReviewInternalFinanceDto {
  @IsIn(Object.values(INTERNAL_FINANCE_REVIEW_DECISION))
  decision: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

export class AddInternalFinanceAttachmentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments: InternalFinanceAttachmentDto[];
}

export class UpdateInternalFinanceCashIssuedDto {
  @IsBoolean()
  cashIssued: boolean;
}

export class PrepareWeeklyBatchDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsDateString()
  weekStart: string;

  @IsDateString()
  weekEnd: string;
}

export class AddWeeklyBatchEntriesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  entryIds: number[];
}

export class CreateApprovalForWeeklyBatchDto {
  @IsOptional()
  @IsString()
  detailUrl?: string;

  @IsOptional()
  @IsString()
  viewUrl?: string;
}

export const INTERNAL_FINANCE_CATEGORIES = Object.values(
  INTERNAL_FINANCE_CATEGORY,
);
export const INTERNAL_FINANCE_DIRECTIONS = Object.values(
  INTERNAL_FINANCE_DIRECTION,
);

export class WarehouseReceiptCustomerInputDto {
  @IsInt()
  @Type(() => Number)
  customerId: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  invoiceIds?: number[];
}

export class CreateWarehouseReceiptDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsIn(['CUSTOMER', 'WAREHOUSE_SALE'])
  receiptKind?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseReceiptCustomerInputDto)
  customers?: WarehouseReceiptCustomerInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class UpdateWarehouseReceiptDto {
  @IsOptional()
  @IsIn(['CUSTOMER', 'WAREHOUSE_SALE'])
  receiptKind?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseReceiptCustomerInputDto)
  customers?: WarehouseReceiptCustomerInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class WarehouseReceiptInvoiceAllocationDto {
  @IsInt()
  @Type(() => Number)
  invoiceId: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount: number;
}

export class WarehouseReceiptCustomerAllocationDto {
  @IsInt()
  @Type(() => Number)
  customerId: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseReceiptInvoiceAllocationDto)
  invoices?: WarehouseReceiptInvoiceAllocationDto[];
}

export class PostWarehouseReceiptDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseReceiptCustomerAllocationDto)
  allocations: WarehouseReceiptCustomerAllocationDto[];
}

export class CancelWarehouseReceiptDto {
  @IsBoolean()
  cancelCashFlows: boolean;
}

export class WarehouseExpenseQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsIn(['ISSUED', 'NOT_ISSUED'])
  cashIssued?: string;

  @IsOptional()
  @IsIn(['CHECKED', 'UNCHECKED'])
  checkStatus?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsString()
  expenseItem?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  vehicleId?: number;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['occurredAt', 'amount'])
  orderBy?: 'occurredAt' | 'amount';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit = 50;
}

export class CreateWarehouseExpenseDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  // Bỏ trống khi nhập Số lượng × Đơn giá.
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsDateString()
  occurredAt: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsIn(WAREHOUSE_EXPENSE_ITEMS)
  expenseItem?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Type(() => Number)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class UpdateWarehouseExpenseDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(WAREHOUSE_EXPENSE_ITEMS)
  expenseItem?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Type(() => Number)
  quantity?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice?: number | null;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  payerId?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class MarkWarehouseExpenseIssuedDto {
  @IsBoolean()
  cashIssued: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CancelWarehouseExpenseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class CreateWarehouseExpenseNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  mentionUserIds?: number[];
}

export class CheckWarehouseExpenseDto {
  @IsIn(['manager', 'accountant'])
  role: 'manager' | 'accountant';

  @IsBoolean()
  checked: boolean;
}

export class BulkCheckWarehouseExpenseDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids: number[];

  @IsIn(['manager', 'accountant'])
  role: 'manager' | 'accountant';
}

/** Lọc trang "Đơn Lark Approval". */
export class LarkApprovalQueryDto extends InternalFinanceQueryDto {
  @IsOptional()
  @IsIn(['PHIEU_THU', 'PHIEU_CHI', 'PHIEU_CHI_KHO_HN', 'PHIEU_CHI_KHO_SG'])
  formKind?: string;

  /** IN: đã / sẽ thành phiếu POS; OUT: chỉ xem (ngoài phạm vi). */
  @IsOptional()
  @IsIn(['IN', 'OUT'])
  scope?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  suspect?: string;
}

/** Kế toán kho xác nhận số tiền mặt thực nhận của phiếu thu tiền mặt kho. */
export class ConfirmWarehouseReceiptAmountDto {
  @IsIn(['MATCH', 'MANUAL', 'CLEAR'])
  mode: 'MATCH' | 'MANUAL' | 'CLEAR';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}
