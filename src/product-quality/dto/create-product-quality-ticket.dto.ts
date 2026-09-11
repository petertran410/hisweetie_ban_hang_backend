import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AttachmentInputDto {
  @IsNotEmpty()
  @IsString()
  filename: string;

  @IsNotEmpty()
  @IsString()
  url: string;

  @IsOptional()
  @IsString()
  originalName?: string;

  @IsOptional()
  @IsString()
  mimetype?: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  kind?: string; // PROOF_IMAGE | PROOF_VIDEO | COMPLETION_PROOF

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  larkFileToken?: string;
}

export class CreateProductQualityTicketDto {
  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsOptional()
  @IsNumber()
  customerId?: number;

  @IsNotEmpty({ message: 'Tên khách hàng không được để trống' })
  @IsString()
  customerName: string;

  @IsOptional()
  @IsString()
  customerCode?: string;

  @IsOptional()
  @IsNumber()
  productId?: number;

  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  @IsString()
  productName: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsNotEmpty({ message: 'Số lượng không được để trống' })
  @Type(() => Number)
  @IsNumber({}, { message: 'Số lượng phải là số' })
  quantity: number;

  @IsOptional()
  @IsString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsNotEmpty({ message: 'Phân loại sự cố ban đầu không được để trống' })
  @IsString()
  initialClassification: string;

  @IsNotEmpty({ message: 'Loại phản hồi không được để trống' })
  @IsString()
  feedbackType: string;

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
  @IsString()
  note?: string;

  @IsOptional()
  @IsNumber()
  invoiceId?: number;

  @IsOptional()
  @IsString()
  invoiceCode?: string;

  @IsOptional()
  @IsNumber()
  outboundInvoiceId?: number;

  @IsOptional()
  @IsString()
  outboundInvoiceCode?: string;

  @IsNotEmpty({ message: 'Vui lòng chọn người phụ trách chính' })
  @Type(() => Number)
  @IsNumber({}, { message: 'ID người phụ trách chính phải là số' })
  decisionMakerId?: number;

  @IsOptional()
  @IsString()
  decisionMakerName?: string;

  @IsOptional()
  @IsString()
  handlingDirection?: string;

  @IsOptional()
  @IsArray()
  assignedDepartments?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentInputDto)
  attachments?: AttachmentInputDto[];
}
