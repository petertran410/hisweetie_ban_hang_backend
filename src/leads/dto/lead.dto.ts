import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  LEAD_CATEGORIES,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from '../leads.constants';

export class LeadConversationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  tid: string;

  @IsString()
  @MaxLength(40)
  platform: string;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class UpsertLeadDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  zaloPhone?: string;

  @IsOptional()
  @IsIn(LEAD_SOURCES as unknown as string[])
  source?: string;

  // Kênh (page Smax) khách nhắn tới — page_pid + tên kênh
  @IsOptional()
  @IsString()
  @MaxLength(80)
  channelPid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  channelName?: string;

  @IsOptional()
  @IsIn(LEAD_CATEGORIES as unknown as string[])
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  provinceCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  provinceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  wardCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  wardName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  need?: string;

  @IsOptional()
  @IsIn(LEAD_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cskhUserId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cskhNote?: string;

  // Tạo lead từ hội thoại Smax chưa gắn khách → lead mang sẵn kênh kết nối
  @IsOptional()
  @ValidateNested()
  @Type(() => LeadConversationDto)
  conversation?: LeadConversationDto;
}

export class LeadListQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  // Danh sách, phân tách dấu phẩy
  @IsOptional()
  @IsString()
  sources?: string;

  @IsOptional()
  @IsString()
  categories?: string;

  @IsOptional()
  @IsString()
  statuses?: string;

  @IsOptional()
  @IsString()
  provinceCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  salePicId?: number;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

export class ConvertLeadDto {
  @Type(() => Number)
  @IsInt()
  customerId: number;
}

export class HandoverLeadDto {
  @Type(() => Number)
  @IsInt()
  salePicId: number;

  // Kênh Zalo cá nhân của Sale dùng để kết bạn + gửi tin chào
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  larkText: string;

  // Zalo giới hạn lời mời kết bạn 150 ký tự
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  friendMessage: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  greeting: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class RetryHandoverDto {
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class LeadTemplatesDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  greeting?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  friend?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  lark?: string;
}

export class HandoverCheckQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  salePicId?: number;

  @IsOptional()
  @IsString()
  pagePid?: string;
}
