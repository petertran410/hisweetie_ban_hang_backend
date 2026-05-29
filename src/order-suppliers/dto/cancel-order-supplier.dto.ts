import { IsBoolean, IsOptional } from 'class-validator';

/**
 * DTO hủy phiếu đặt hàng nhập (PDN). Đối xứng `CancelOrderDto` của phía bán.
 *   - cancelPayments=true → soft cancel mọi OrderSupplierPayment + CashFlow
 *     PCPDN của PDN, set paidAmount=0, supplierDebt=0.
 *   - cancelPayments=false/undefined → chỉ set status=CANCELLED, KHÔNG đụng
 *     payment (nhưng PDN không thể hủy nếu còn thanh toán đã chi — sẽ throw).
 */
export class CancelOrderSupplierDto {
  @IsBoolean()
  @IsOptional()
  cancelPayments?: boolean;
}
