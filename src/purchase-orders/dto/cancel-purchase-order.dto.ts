import { IsBoolean, IsOptional } from 'class-validator';

/**
 * DTO hủy phiếu nhập hàng (PN). Đối xứng `CancelOrderSupplierDto` /
 * `CancelOrderDto` của phía bán.
 *
 *   - cancelPayments=true  → soft cancel mọi PurchaseOrderPayment + CashFlow
 *     PCPN của PN, set paidAmount=0, supplierDebt=0.
 *   - cancelPayments=false / undefined → chỉ set status=CANCELLED và hoàn nguyên
 *     kho. Nếu còn payment active sẽ throw — buộc user quyết định rõ.
 */
export class CancelPurchaseOrderDto {
  @IsBoolean()
  @IsOptional()
  cancelPayments?: boolean;
}
