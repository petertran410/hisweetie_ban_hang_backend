import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Tệp đã tải lên POS (POST /smax/chat/attachments hoặc lấy từ Thư viện Smax). */
export class QuickReplyMediaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  path: string;

  @IsIn(['image', 'video', 'file'])
  kind: 'image' | 'video' | 'file';

  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsInt()
  size?: number;
}

export class UpdateQuickReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  shortcut: string;

  // Có thể để trống khi tin chỉ có media
  @IsString()
  @MaxLength(2100)
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => QuickReplyMediaDto)
  media?: QuickReplyMediaDto[];
}

export class CreateQuickReplyDto extends UpdateQuickReplyDto {
  // true: tin nhắn nhanh chung (cần quyền smax_chat:manage_quick_replies)
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}
