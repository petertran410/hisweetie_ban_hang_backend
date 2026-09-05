import {
  IsOptional,
  IsString,
  IsIn,
  IsBoolean,
  IsInt,
  IsNumber,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  DEBT_STATUSES,
  DEBT_FORMS,
  PAYMENT_HISTORIES,
} from '../debt-tracking.constants';

export class DebtTrackingQueryDto {
  /** Tìm theo mã hoặc tên khách hàng. */
  @IsOptional()
  @IsString()
  search?: string;

  /** Trạng thái nợ: OVERDUE | DUE | NORMAL */
  @IsOptional()
  @IsString()
  @IsIn(DEBT_STATUSES)
  debtStatus?: string;

  /** Lọc khách có áp hạn mức. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasCreditLimit?: boolean;

  /** Lọc khách có áp hạn theo ngày. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasTermDays?: boolean;

  /** Lọc theo lịch sử thanh toán ĐANG ÁP DỤNG (auto hoặc override). */
  @IsOptional()
  @IsString()
  @IsIn(PAYMENT_HISTORIES)
  paymentHistory?: string;

  /** Chỉ khách đã vượt hạn mức. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  overLimitOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  /** Lọc theo Sale phụ trách. */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  salePicId?: number;

  /** Lọc theo Kế toán công nợ phụ trách. */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountantPicId?: number;

  /** Lọc theo hình thức công nợ. */
  @IsOptional()
  @IsString()
  @IsIn(DEBT_FORMS)
  debtForm?: string;

  /** true = chỉ khách CHƯA có phiếu thu hồi nợ đang mở. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  withoutOpenTicket?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsString()
  @IsIn([
    'debtStatus',
    'totalDebt',
    'overdueAmount',
    'requiredPaymentAmount',
    'daysOverdue',
    'overLimit',
    'name',
  ])
  orderBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  orderDirection?: 'asc' | 'desc';
}

/**
 * Chính sách công nợ — HAI CHIỀU ĐỘC LẬP.
 * Bật `hasTermDays` thì bắt buộc có `termDays`; bật `hasCreditLimit` thì
 * bắt buộc có `creditLimit`. Tắt cả hai = khách không công nợ.
 */
export class UpsertDebtPolicyDto {
  @IsBoolean()
  hasCreditLimit!: boolean;

  @ValidateIf((o: UpsertDebtPolicyDto) => o.hasCreditLimit === true)
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  creditLimit?: number;

  @IsBoolean()
  hasTermDays!: boolean;

  @ValidateIf((o: UpsertDebtPolicyDto) => o.hasTermDays === true)
  @IsInt()
  @Min(0)
  @Max(3650)
  @Type(() => Number)
  termDays?: number;

  /**
   * Cam kết số lần trả tiền mỗi tháng (ví dụ "1 tháng 2 lần" → 2).
   * Không sinh hạn thanh toán, chỉ dùng để theo dõi tần suất.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  @Type(() => Number)
  paymentFrequency?: number | null;

  @IsOptional()
  @IsString()
  @IsIn(DEBT_FORMS)
  debtForm?: string | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  salePicId?: number | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountantPicId?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Khách mới có thể bị yêu cầu trả đủ trước khi tạo hóa đơn POS. */
  @IsOptional()
  @IsBoolean()
  requireFullPaymentForInvoice?: boolean;
}

export class UpdatePaymentHistoryOverrideDto {
  /** Mức đánh giá áp dụng do người dùng chọn. */
  @IsString()
  @IsIn(PAYMENT_HISTORIES)
  paymentHistoryOverride!: string;

  /** Bắt buộc ghi lý do khi thay kết luận tự động của hệ thống. */
  @IsString()
  @Max(1000)
  reason!: string;
}

export class UpdateDebtNoteDto {
  /** Ghi chú dùng chung của khách. Gửi null/chuỗi rỗng để xóa. */
  @IsOptional()
  @IsString()
  note?: string | null;
}
