import { IsOptional, IsString, IsIn, IsNumberString } from 'class-validator';

/**
 * Query filter cho danh sách giao dịch Sepay (GET /sepay/transactions).
 * Tất cả optional — không truyền thì lấy toàn bộ (có phân trang).
 */
export class SepayTransactionQueryDto {
  @IsOptional()
  @IsNumberString()
  page?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string;

  /** Tìm trong nội dung giao dịch + mã tham chiếu */
  @IsOptional()
  @IsString()
  search?: string;

  /** Lọc theo số tài khoản ngân hàng nhận */
  @IsOptional()
  @IsString()
  accountNumber?: string;

  /** Lọc theo loại: 'in' (tiền vào) | 'out' (tiền ra) */
  @IsOptional()
  @IsIn(['in', 'out'])
  transferType?: 'in' | 'out';

  /** Từ ngày (ISO date hoặc yyyy-mm-dd), lọc theo transactionDate >= */
  @IsOptional()
  @IsString()
  dateFrom?: string;

  /** Đến ngày (ISO date hoặc yyyy-mm-dd), lọc theo transactionDate <= */
  @IsOptional()
  @IsString()
  dateTo?: string;

  /** Lọc theo trạng thái đối soát: processing | assigned | completed */
  @IsOptional()
  @IsIn(['processing', 'assigned', 'completed'])
  status?: 'processing' | 'assigned' | 'completed';
}
