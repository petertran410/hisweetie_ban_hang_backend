import {
  IsInt,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
  ValidateNested,
  IsBoolean,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PayableAllocationDto } from '../../manufacturers/dto';

/**
 * DTO cho endpoint POST /api/cashflows/supplier-payments — đối xứng
 * `CreateCustomerPaymentDto` của KH:
 *   - customerId → supplierId
 *   - allocateToInvoices → allocateToPurchaseOrders
 *   - invoices[] → purchaseOrders[]
 *   - debtOffsets[].invoiceId → purchaseOrderId
 *
 * Ngữ nghĩa: user CHI (isReceipt=false) tổng `totalAmount` cho NCC, BE phân
 * bổ thành PurchaseOrderPayment cho từng PN, và ghi `debtOffsets` cấn trừ
 * cho phần dư (nếu user trả thừa NCC, tạo SupplierReturn `manual_offset` để
 * giữ "credit" với NCC).
 */
class PurchaseOrderPaymentItem {
  @IsInt()
  @Type(() => Number)
  purchaseOrderId: number;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsNumber()
  exchangeRate?: number;

  @IsOptional()
  @IsNumber()
  foreignAmount?: number;
}

class SupplierDebtOffsetItem {
  @IsInt()
  @Type(() => Number)
  purchaseOrderId: number;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsNumber()
  exchangeRate?: number;

  @IsOptional()
  @IsNumber()
  foreignAmount?: number;
}

export class CreateSupplierPaymentDto {
  @IsOptional() @IsString() requestKey?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => PayableAllocationDto) allocations?: PayableAllocationDto[];
  @IsInt()
  @Type(() => Number)
  supplierId: number;

  @IsNumber()
  @Min(0)
  totalAmount: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsDateString()
  transDate?: string;

  @IsString()
  method: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  collectorUserId?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  allocateToPurchaseOrders?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderPaymentItem)
  purchaseOrders?: PurchaseOrderPaymentItem[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierDebtOffsetItem)
  debtOffsets?: SupplierDebtOffsetItem[];
}
