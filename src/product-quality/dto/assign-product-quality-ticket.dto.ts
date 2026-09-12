import {
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AttachmentInputDto } from './create-product-quality-ticket.dto';

export class AssignProductQualityTicketDto {
  @IsOptional()
  @IsNumber()
  decisionMakerId?: number;

  @IsOptional()
  @IsString()
  handlingDirection?: string;

  @IsOptional()
  @IsArray()
  assignedDepartments?: string[]; // Kinh Doanh, Kho + Logistics, Kế Toán Kho, Thu Mua

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsArray()
  responsibilities?: string[];

  @IsOptional()
  @IsString()
  factoryName?: string;

  @IsOptional()
  @IsNumber()
  factoryId?: number;

  @IsOptional()
  @IsNumber()
  outboundInvoiceId?: number;

  @IsOptional()
  @IsString()
  outboundInvoiceCode?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  note?: string;

  /** Ảnh/video minh chứng mới tải lên trong bước xử lý. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentInputDto)
  attachments?: AttachmentInputDto[];

  /** Danh sách id attachment cần bỏ khỏi phiếu (ảnh/video đã thêm sai). */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  removeAttachmentIds?: number[];
}
