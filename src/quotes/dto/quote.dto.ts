import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  QUOTE_CATEGORIES,
  QUOTE_LAYOUTS,
  QUOTE_REGIONS,
  QUOTE_STATUSES,
} from '../quotes.constants';

/** Khung giá không giá (mẫu báo giá). */
export class QuoteTierDefDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  key: string;

  @IsString()
  @MaxLength(120)
  label: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minQty: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxQty: number | null;

  @IsString()
  @MaxLength(20)
  unit: string;
}

export class QuoteTierDto extends QuoteTierDefDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  price: number | null;

  @IsBoolean()
  manual: boolean;
}

export class QuoteItemDto {
  /** Khoá dòng phía client — không lưu. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  id?: string;

  @IsOptional()
  @IsInt()
  productId: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  productCode: string | null;

  /** Tên sản phẩm POS đầy đủ lúc thêm (null = dòng không lấy từ POS). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string | null;

  /** Tên hiển thị trên báo giá. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  productName: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  weight?: string;

  @IsString()
  @MaxLength(120)
  spec: string;

  @IsString()
  @MaxLength(20)
  unit: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  basePrice: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceBookPrice: number | null;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => QuoteTierDto)
  tiers: QuoteTierDto[];

  @IsOptional()
  @IsBoolean()
  comingSoon?: boolean;

  /** Hàng lạnh — lấy từ sản phẩm POS khi đọc, không lưu. */
  @IsOptional()
  @IsBoolean()
  cold?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QuoteCustomerDto {
  /** null = khách chưa có trong POS (chỉ in lên báo giá). */
  @IsOptional()
  @IsInt()
  id: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  code: string | null;

  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;
}

export class QuotePriceBookDto {
  @IsInt()
  id: number;

  @IsString()
  @MaxLength(255)
  name: string;
}

/** Thân tạo / sửa báo giá — trùng kiểu QuotePayload của frontend. */
export class QuotePayloadDto {
  @IsBoolean()
  isLibrary: boolean;

  @IsIn(QUOTE_STATUSES)
  status: string;

  @IsOptional()
  @IsInt()
  templateId: number | null;

  @IsIn(QUOTE_LAYOUTS)
  layout: string;

  @IsIn(QUOTE_REGIONS)
  region: string;

  @IsOptional()
  @IsIn(QUOTE_CATEGORIES)
  category: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteCustomerDto)
  customer: QuoteCustomerDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuotePriceBookDto)
  priceBook: QuotePriceBookDto | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl: string | null;

  @IsString()
  @MaxLength(255)
  companyName: string;

  @IsString()
  @MaxLength(120)
  department: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @MaxLength(255)
  greeting: string;

  @IsString()
  @MaxLength(3000)
  intro: string;

  @IsString()
  @MaxLength(3000)
  closing: string;

  @IsString()
  @MaxLength(3000)
  note: string;

  @IsBoolean()
  showMargin: boolean;

  @IsDateString()
  appliedFrom: string;

  @IsOptional()
  @IsDateString()
  validUntil: string | null;

  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items: QuoteItemDto[];

  @IsOptional()
  @IsInt()
  sourceLibraryId: number | null;
}

const toArray = ({ value }: { value: unknown }) =>
  value == null || value === ''
    ? undefined
    : Array.isArray(value)
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? String(value).split(',')
        : undefined;

export class QuoteListQueryDto {
  @IsIn(['quotes', 'library'])
  tab: 'quotes' | 'library';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(toArray)
  @IsIn(QUOTE_STATUSES, { each: true })
  status?: string[];

  /** Lọc theo mẫu báo giá (Cài đặt › Mẫu báo giá). */
  @IsOptional()
  @Transform(({ value }) => toArray({ value })?.map(Number))
  @IsInt({ each: true })
  templateId?: number[];

  @IsOptional()
  @Transform(({ value }) => toArray({ value })?.map(Number))
  @IsInt({ each: true })
  createdById?: number[];

  @IsOptional()
  @Transform(toArray)
  @IsIn(QUOTE_REGIONS, { each: true })
  region?: string[];

  @IsOptional()
  @Transform(toArray)
  @IsIn(QUOTE_CATEGORIES, { each: true })
  category?: string[];

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class QuoteStatusDto {
  @IsIn(QUOTE_STATUSES)
  status: string;
}

/** Thân tạo / sửa mẫu báo giá — trùng QuoteTemplatePayload của frontend. */
export class QuoteTemplatePayloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Gắn với mẫu, không sửa trên form — mẫu mới / nhân bản lấy theo mẫu gốc. */
  @IsIn(QUOTE_LAYOUTS)
  layout: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl: string | null;

  @IsString()
  @MaxLength(255)
  companyName: string;

  @IsString()
  @MaxLength(120)
  department: string;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => QuoteTierDefDto)
  tiers: QuoteTierDefDto[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  titlePattern: string;

  @IsString()
  @MaxLength(255)
  greeting: string;

  @IsString()
  @MaxLength(3000)
  intro: string;

  @IsString()
  @MaxLength(3000)
  note: string;

  @IsString()
  @MaxLength(3000)
  closing: string;

  @IsBoolean()
  showMargin: boolean;
}

export class QuoteTemplateActiveDto {
  @IsBoolean()
  isActive: boolean;
}
