import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_DIRECTION,
  INTERNAL_FINANCE_REVIEW_DECISION,
} from '../internal-finance.constants';
import { LARK_IMPORT_SOURCES } from '../internal-finance-lark-import.mapper';

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

  @IsString()
  vehicle: string;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsNumber()
  @Min(0)
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
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  consumptionLimit?: number;

  @IsOptional()
  @IsString()
  anomalyNote?: string;

  @IsOptional()
  @IsString()
  description?: string;

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

  @IsString()
  vehicle: string;

  @IsString()
  serviceType: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsDateString()
  occurredAt: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  odo?: number;

  @IsOptional()
  @IsString()
  anomalyNote?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
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

export class LarkFinanceImportDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(LARK_IMPORT_SOURCES, { each: true })
  sources?: string[];
}

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

export class WarehouseCashImportDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
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

export class CreateWarehouseExpenseDto {
  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsDateString()
  occurredAt: string;

  @IsString()
  description: string;

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InternalFinanceAttachmentDto)
  attachments?: InternalFinanceAttachmentDto[];
}

export class MarkWarehouseExpenseIssuedDto {
  @IsBoolean()
  cashIssued: boolean;
}
