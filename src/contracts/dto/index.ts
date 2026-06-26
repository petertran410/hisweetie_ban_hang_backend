import {
  IsInt,
  IsOptional,
  IsString,
  IsEmail,
  IsIn,
  ValidateNested,
  IsObject,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CONTRACT_STATUSES = [
  'DRAFT',
  'REVIEW_SENT', // Phase 1: đã gửi bản xem cho khách (Lark Mail)
  'REVIEW_APPROVED', // Khách đồng ý nội dung
  'SENT', // Phase 2: đã gửi bản ký Documenso cho khách
  'SIGNED', // Khách đã ký xong
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * Dữ liệu prefill nhận từ FE (đã map sẵn từ Customer, nhân viên sửa tay được).
 * Key = label field trong template Documenso; value = giá trị điền.
 * Backend sẽ resolve label → fieldId qua getTemplate.
 */
export class ContractPrefillDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  taxCode?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

/**
 * Một field điền sẵn dạng id-based (động theo template). FE gửi fieldId lấy từ
 * GET /contracts/templates/:id/fields. value luôn là string (BE tự ép theo type).
 */
export class PrefillFieldItemDto {
  @IsInt()
  fieldId: number;

  @IsString()
  value: string;
}

export class CreateFromTemplateDto {
  @IsInt()
  customerId: number;

  /** Override template id mặc định (ENV DOCUMENSO_TEMPLATE_ID) nếu cần. */
  @IsOptional()
  @IsInt()
  templateId?: number;

  @IsOptional()
  @IsString()
  title?: string;

  /** Email người nhận; nếu rỗng sẽ lấy customer.email. */
  @IsOptional()
  @IsEmail()
  recipientEmail?: string;

  /**
   * Prefill động id-based (ưu tiên). Mỗi item map 1 field công ty điền.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PrefillFieldItemDto)
  prefillFields?: PrefillFieldItemDto[];

  /** (Cũ) prefill label-based — giữ tương thích ngược, optional. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ContractPrefillDto)
  prefill?: ContractPrefillDto;
}

export class UploadContractDto {
  @Type(() => Number)
  @IsInt()
  customerId: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEmail()
  recipientEmail?: string;
}

export class ContractQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  customerId?: number;

  @IsOptional()
  @IsString()
  @IsIn(CONTRACT_STATUSES as unknown as string[])
  status?: ContractStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pageSize?: number;
}

/**
 * Payload webhook Documenso. event + payload (envelope).
 * vd event: DOCUMENT_COMPLETED | DOCUMENT_REJECTED | DOCUMENT_CANCELLED
 */
export class DocumensoWebhookDto {
  @IsString()
  event: string;

  @IsObject()
  payload: {
    id: number | string;
    title?: string;
    status?: string;
    completedAt?: string;
    recipients?: Array<{
      id: number;
      email: string;
      signingStatus?: string;
    }>;
    [k: string]: any;
  };

  @IsOptional()
  createdAt?: string;
}
