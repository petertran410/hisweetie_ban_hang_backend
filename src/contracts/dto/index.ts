import {
  IsInt,
  IsOptional,
  IsString,
  IsEmail,
  IsIn,
  IsBoolean,
  ValidateNested,
  IsObject,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CONTRACT_STATUSES = [
  'DRAFT',
  'SENT', // Đã gửi bản ký Documenso cho khách/NV (tuỳ thứ tự).
  'PARTIALLY_SIGNED', // HĐ 2 bên, 1 bên đã ký, đang chờ bên còn lại.
  'SIGNED', // Tất cả bên đã ký xong.
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_TYPES = ['SINGLE', 'DOUBLE'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

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

  /**
   * Email Documenso user của NV ký BÊN A (chỉ dùng khi HĐ Loại 2 — 2 bên ký).
   * FE chọn từ dropdown danh sách Documenso user (xem /contracts/signers).
   * Nếu rỗng → fallback lấy user active đầu tiên trong DB, cuối cùng là ENV.
   */
  @IsOptional()
  @IsEmail()
  companySignerEmail?: string;
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

/**
 * DTO tạo mới 1 người ký (Documenso user BÊN A) trong bảng ContractSigner.
 */
export class CreateContractSignerDto {
  @IsEmail()
  documensoEmail: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * DTO cập nhật người ký. Tất cả field optional — chỉ update field nào gửi lên.
 */
export class UpdateContractSignerDto {
  @IsOptional()
  @IsEmail()
  documensoEmail?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
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
 * Payload webhook Documenso. event + payload (envelope/document).
 * Documenso v2.14: DOCUMENT_RECIPIENT_COMPLETED | DOCUMENT_SIGNED |
 * DOCUMENT_COMPLETED | DOCUMENT_REJECTED | DOCUMENT_CANCELLED
 * (không còn RECIPIENT_SIGNED).
 */
export class DocumensoWebhookDto {
  @IsString()
  event: string;

  @IsObject()
  payload: {
    id: number | string;
    envelopeId?: string;
    title?: string;
    status?: string;
    completedAt?: string;
    externalId?: string;
    recipients?: Array<{
      id: number;
      email: string;
      signingStatus?: string;
      token?: string;
    }>;
    Recipient?: Array<{
      id: number;
      email: string;
      signingStatus?: string;
      token?: string;
    }>;
    [k: string]: any;
  };

  @IsOptional()
  createdAt?: string;
}
