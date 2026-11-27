import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const toStringArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const toNumberArray = ({ value }: { value: unknown }) => {
  const arr = toStringArray({ value });
  return arr?.map(Number).filter((n) => Number.isInteger(n));
};

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1' || value === 1;

export class NppQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  stages?: string[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  statuses?: string[];

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  parentNames?: string[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  tradeMarkIds?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  createdByIds?: number[];

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  mine?: boolean;
}

export class NppAttachmentDto {
  @IsString()
  @IsNotEmpty()
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
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  larkFileToken?: string;
}

export class NppOemCustomerDto {
  @Type(() => Number)
  @IsInt()
  customerId: number;
}

/** Mọi trường sửa được của phiếu; service kiểm tra trường nào người dùng được sửa. */
export class UpdateNppDto {
  @IsOptional() @IsString() @MaxLength(500) productName?: string;
  @IsOptional() @IsString() parentName?: string | null;
  @IsOptional() @IsString() childName?: string | null;
  @IsOptional() @IsString() middleName?: string | null;
  @IsOptional() @IsInt() tradeMarkId?: number | null;
  @IsOptional() @IsString() unit?: string | null;
  @IsOptional() @IsNumber() @Min(0) netWeightGram?: number | null;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() costApproverId?: number | null;

  @IsOptional() @IsInt() supplierId?: number | null;
  @IsOptional() @IsInt() factoryId?: number | null;
  @IsOptional() @IsNumber() @Min(0) moqCartons?: number | null;
  @IsOptional() @IsString() deliveryTerms?: string | null;
  @IsOptional() @IsString() importName?: string | null;
  @IsOptional() @IsString() arrivalDate?: string | null;
  @IsOptional() @IsString() launchDate?: string | null;
  @IsOptional() @IsNumber() @Min(0) packingSpec?: number | null;
  @IsOptional() @IsNumber() @Min(0) goodsPrice?: number | null;
  @IsOptional() @IsNumber() @Min(0) exchangeRate?: number | null;
  @IsOptional() @IsNumber() @Min(0) vatTax?: number | null;
  @IsOptional() @IsNumber() @Min(0) importTax?: number | null;
  @IsOptional() @IsNumber() @Min(0) overheadCost?: number | null;
  @IsOptional() @IsNumber() @Min(0) costHn?: number | null;
  @IsOptional() @IsNumber() @Min(0) costSg?: number | null;

  @IsOptional() @IsString() misaCode?: string | null;
  @IsOptional() @IsNumber() @Min(0) cogsHn?: number | null;
  @IsOptional() @IsNumber() @Min(0) cogsSg?: number | null;
  @IsOptional() @IsNumber() @Min(0) cogsDt?: number | null;

  @IsOptional() @IsNumber() @Min(0) priceHnRetail?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceHnWholesale?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceSgRetail?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceSgWholesale?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceDlcl?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceShopee?: number | null;
  @IsOptional() @IsNumber() @Min(0) priceOem?: number | null;
  @IsOptional() @IsInt() oemPriceBookId?: number | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NppOemCustomerDto)
  oemCustomers?: NppOemCustomerDto[] | null;

  @IsOptional() @IsString() note?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NppAttachmentDto)
  images?: NppAttachmentDto[] | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NppAttachmentDto)
  documents?: NppAttachmentDto[] | null;
}

/** Tên hàng hóa bắt buộc — service kiểm tra (metadata IsOptional của lớp cha kế thừa sang). */
export class CreateNppDto extends UpdateNppDto {
  /** true = gửi luôn sang Phòng Thu Mua (kiểm tra đủ trường bắt buộc). */
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}

export class NppReasonDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập lý do' })
  @MaxLength(2000)
  reason: string;
}

export class NppDecisionDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /** CEO từ chối: true = kết thúc phiếu, false = trả về Thu Mua làm lại. */
  @IsOptional()
  @IsBoolean()
  end?: boolean;
}

export class NppCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập nội dung' })
  @MaxLength(4000)
  content: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NppAttachmentDto)
  attachments?: NppAttachmentDto[];
}

export class NppConfigDto {
  /** {PURCHASING:[userId], ACCOUNTING:[], CHIEF_ACCOUNTANT:[], SALES:[], CEO:[], DATA:[]} */
  @IsOptional()
  @IsObject()
  approvers?: Record<string, number[]>;

  /** {HN_RETAIL: 'BASE_PRICE' | priceBookId | null, ...} */
  @IsOptional()
  @IsObject()
  priceTargets?: Record<string, string | number | null>;

  /** {HN:[branchId], SG:[...], DT:[...]} */
  @IsOptional()
  @IsObject()
  costBranches?: Record<string, number[]>;

  @IsOptional()
  @IsString()
  larkChatId?: string | null;

  @IsOptional()
  @IsBoolean()
  remindersEnabled?: boolean;

  /** Gửi thử: chỉ gửi mọi thông báo tới những user này ([] = gửi thật). */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  testRecipients?: number[];
}

export class NppLarkImportDto {
  /** true = chỉ xem trước, không ghi. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** Tải ảnh & tài liệu đính kèm về máy chủ. */
  @IsOptional()
  @IsBoolean()
  downloadMedia?: boolean;

  /** Ghi đè cả phiếu đã sửa trên POS sau lần nhập trước. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsString()
  baseToken?: string;

  @IsOptional()
  @IsString()
  tableId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class NppCustomerSearchDto {
  @IsOptional()
  @IsString()
  search?: string;
}
