import {
  IsOptional,
  IsString,
  MinLength,
  IsInt,
  IsIn,
  IsArray,
  IsNumber,
  ArrayMinSize,
  Min,
  Max,
  ValidateNested,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DEBT_TICKET_STATUSES,
  DEBT_TICKET_LINE_STATUSES,
  DEBT_TICKET_TYPES,
} from '../../debt-tracking/debt-tracking.constants';

export class DebtTicketCustomerInputDto {
  @IsInt()
  @Type(() => Number)
  customerId!: number;

  /**
   * Số tiền TỐI THIỂU cần phải thanh toán.
   * Bỏ trống ⇒ hệ thống tự tính = phần nợ đã đến hạn.
   * Nhân viên sửa được; thấp hơn 30% nợ đầu kì sẽ bị cảnh báo (không chặn).
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  minimumPayment?: number;

  /** Số tiền khách XÁC NHẬN sẽ trả — có thể nhỏ hơn mức tối thiểu. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  confirmedAmount?: number;

  /** Ngày khách xác nhận thanh toán. */
  @IsOptional()
  @IsDateString()
  confirmedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateDebtTicketDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  /** Nhân viên phụ trách đi thu hồi nợ. */
  @IsInt()
  @Type(() => Number)
  assigneeId!: number;

  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /** DEBT_COLLECTION hoặc STOP_DELIVERY. Mặc định là thu hồi công nợ. */
  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_TYPES)
  ticketType?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DebtTicketCustomerInputDto)
  customers!: DebtTicketCustomerInputDto[];
}

export class StopDeliveryTicketDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  customerId!: number;
}

export class UpdateDebtTicketDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  assigneeId?: number;

  /** Chuyển bước trong quá trình thu hồi nợ. */
  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateDebtTicketLineDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  minimumPayment?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  confirmedAmount?: number;

  @IsOptional()
  @IsDateString()
  confirmedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_LINE_STATUSES)
  status?: string;
}

export class CloseDebtTicketDto {
  /**
   * Bắt buộc khi kết thúc thủ công. Phiếu chỉ tự kết thúc khi MỌI khách đã
   * thu đủ; còn khách chưa đủ thì người kết thúc phải nêu lý do để truy vết.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;

  /** Trạng thái kết thúc: DONE (đã xong) hoặc ENDED (dừng, không thu được). */
  @IsOptional()
  @IsString()
  @IsIn(['DONE', 'ENDED'])
  finalStatus?: string;
}

export class AddTicketCustomersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DebtTicketCustomerInputDto)
  customers!: DebtTicketCustomerInputDto[];
}

export class DebtTicketQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(DEBT_TICKET_TYPES)
  ticketType?: string;

  /** true = chỉ phiếu còn hoạt động (REQUESTED/IN_PROGRESS/WAITING). */
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  openOnly?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  assigneeId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  customerId?: number;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

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
}
