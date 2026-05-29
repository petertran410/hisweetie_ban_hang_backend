import {
  IsInt,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  amount: number;
}

class SupplierDebtOffsetItem {
  @IsInt()
  @Type(() => Number)
  purchaseOrderId: number;

  @IsNumber()
  amount: number;
}

export class CreateSupplierPaymentDto {
  @IsInt()
  @Type(() => Number)
  supplierId: number;

  @IsNumber()
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
