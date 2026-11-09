import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LEAD_CATEGORIES, LEAD_SOURCES } from '../leads.constants';
import { LEAD_FORM_FIELD_TYPES, LEAD_FORM_SLUG } from '../lead-forms.constants';

export class LeadFormFieldDto {
  @IsString()
  @MaxLength(40)
  key: string;

  @IsString()
  @MaxLength(255)
  label: string;

  @IsBoolean()
  enabled: boolean;

  @IsBoolean()
  required: boolean;

  @IsOptional()
  @IsIn(LEAD_FORM_FIELD_TYPES as unknown as string[])
  type?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  options?: string[];

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  /** Chuỗi / mảng chuỗi / khu vực { provinceCode, provinceName, wardCode, wardName } — kiểm ở service */
  @IsOptional()
  defaultValue?: unknown;
}

export class UpsertLeadFormDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(LEAD_FORM_SLUG, {
    message: 'Đường dẫn chỉ gồm a-z, 0-9, dấu gạch ngang (3–60 ký tự)',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => LeadFormFieldDto)
  fields?: LeadFormFieldDto[];

  @IsOptional()
  @IsIn(LEAD_SOURCES as unknown as string[])
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  channelPid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  channelName?: string;

  @IsOptional()
  @IsIn(['', ...LEAD_CATEGORIES])
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cskhUserId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  successMessage?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SubmitLeadFormDto {
  /** key trường → giá trị (chuỗi; chọn nhiều = mảng; khu vực = { provinceCode, provinceName, wardCode, wardName }) */
  @IsObject()
  answers: Record<string, unknown>;

  /** Honeypot: ô ẩn, người thật để trống */
  @IsOptional()
  @IsString()
  website?: string;
}

export class LeadFormSubmissionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}
