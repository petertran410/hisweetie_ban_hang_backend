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

export class ChatMessagesQueryDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @Type(() => Number)
  @IsInt()
  contactId: number;

  @IsOptional()
  @IsString()
  before?: string;
}

export class ChatAttachmentDto {
  @IsString()
  @IsNotEmpty()
  path: string;

  @IsIn(['image', 'video', 'file'])
  kind: 'image' | 'video' | 'file';

  @IsString()
  @MaxLength(255)
  name: string;
}

export class SendChatMessageDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsInt()
  contactId: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  qrImageUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  productImageIds?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(10)
  stickerId?: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class CreateZaloContactDto {
  @IsIn(['user', 'group'])
  kind: 'user' | 'group';

  @IsString()
  @IsNotEmpty()
  zaloId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class UpdateZaloContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}

export class ZaloLookupQueryDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class SharedGroupsQueryDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  refresh?: string;
}

export class ZaloProfileQueryDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @Type(() => Number)
  @IsInt()
  contactId: number;
}

export class FriendActionDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsInt()
  contactId: number;

  @IsIn(['request', 'accept', 'undo'])
  action: 'request' | 'accept' | 'undo';

  @IsOptional()
  @IsString()
  @MaxLength(150)
  message?: string;
}
