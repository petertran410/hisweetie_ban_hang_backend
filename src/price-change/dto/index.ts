import {
  ArrayMaxSize,
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
import { NppAttachmentDto } from '../../new-product-price/dto';
import { MAX_ITEMS } from '../price-change.constants';

const toStringArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value as string | number)
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

export class PcQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number = 20;
  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(toStringArray) @IsArray() stages?: string[];
  @IsOptional() @Transform(toStringArray) @IsArray() statuses?: string[];
  /** COST = có đổi giá vốn, SALE = có đổi giá bán. */
  @IsOptional() @Transform(toStringArray) @IsArray() types?: string[];
  @IsOptional() @Transform(toNumberArray) @IsArray() createdByIds?: number[];
  @IsOptional() @Transform(toNumberArray) @IsArray() productIds?: number[];

  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() mine?: boolean;
}

export class PcCostLineDto {
  @Type(() => Number) @IsInt() branchId: number;
  /** null / bỏ trống = không đổi. */
  @IsOptional() @IsNumber() @Min(0) newCost?: number | null;
}

export class PcPriceLineDto {
  /** 0 = Bảng giá chung (product.basePrice). */
  @Type(() => Number) @IsInt() @Min(0) priceBookId: number;
  @IsOptional() @IsNumber() @Min(0) newPrice?: number | null;
}

export class PcItemDto {
  @Type(() => Number) @IsInt() productId: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PcCostLineDto)
  costs: PcCostLineDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PcPriceLineDto)
  prices: PcPriceLineDto[];
}

/** Nội dung phiếu. Gửi `items` = thay toàn bộ dòng; giá cũ do máy chủ chụp từ POS. */
export class UpdatePcDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) costBranchIds?: number[];
  @IsOptional() @IsArray() @IsInt({ each: true }) priceBookIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => PcItemDto)
  items?: PcItemDto[];

  @IsOptional() @IsString() @MaxLength(4000) note?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NppAttachmentDto)
  documents?: NppAttachmentDto[] | null;
}

export class CreatePcDto extends UpdatePcDto {
  /** true = gửi luôn cho Kế toán trưởng duyệt. */
  @IsOptional() @IsBoolean() submit?: boolean;
}

export class PcReasonDto {
  @IsString()
  @IsNotEmpty({ message: 'Vui lòng nhập lý do' })
  @MaxLength(2000)
  reason: string;
}

export class PcDecisionDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /** Từ chối: true = kết thúc phiếu, false = trả người đề xuất sửa lại. */
  @IsOptional() @IsBoolean() end?: boolean;
}

export class PcCommentDto {
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

export class PcConfigDto {
  /** {CHIEF_ACCOUNTANT:[userId], CEO:[], DATA:[]} */
  @IsOptional() @IsObject() approvers?: Record<string, number[]>;

  /** chat_id nhóm Lark dạng topic (oc_…); "" = tắt gửi nhóm. */
  @IsOptional() @IsString() @MaxLength(100) larkChatId?: string;

  /** Nhắc việc hằng ngày (17:00). */
  @IsOptional() @IsBoolean() remindersEnabled?: boolean;
}

export class PcCurrentValuesDto {
  @Transform(toNumberArray) @IsArray() productIds: number[];
  @IsOptional() @Transform(toNumberArray) @IsArray() branchIds?: number[];
  @IsOptional() @Transform(toNumberArray) @IsArray() priceBookIds?: number[];
}
