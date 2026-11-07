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

export class ForwardMediaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string;

  @IsIn(['image', 'file'])
  kind: 'image' | 'file';
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
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  packingSlipImageIds?: number[];

  @IsOptional()
  @IsBoolean()
  imagesFirst?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  stickerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  replyToPid?: string;

  // Messenger: gửi kèm thẻ HUMAN_AGENT → lấy lại quyền trả lời từ Meta Business AI
  @IsOptional()
  @IsBoolean()
  humanAgent?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ForwardMediaDto)
  forwardMedia?: ForwardMediaDto[];

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class CreateZaloContactDto {
  @IsIn(['user', 'group'])
  kind: 'user' | 'group';

  // Số Zalo (Zalo cá nhân) hoặc tid hội thoại kênh khác (fb…, zl…, sp…) — khi đó cần pagePid
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  zaloId: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pagePid?: string;

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

export class SendThreadMessageDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

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
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  packingSlipImageIds?: number[];

  @IsOptional()
  @IsBoolean()
  imagesFirst?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  stickerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  replyToPid?: string;

  // Messenger: gửi kèm thẻ HUMAN_AGENT → lấy lại quyền trả lời từ Meta Business AI
  @IsOptional()
  @IsBoolean()
  humanAgent?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ForwardMediaDto)
  forwardMedia?: ForwardMediaDto[];

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class ReactMessageDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  // pid tin nhắn ("zlw" + id Zalo)
  @IsString()
  @IsNotEmpty()
  pid: string;

  @IsIn(['NONE', 'LIKE', 'HEART', 'HAHA', 'WOW', 'CRY', 'ANGRY'])
  reaction: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class RenameThreadDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class PassControlBizAIDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class MessageActionDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  // pid tin nhắn ("zlw" + id Zalo)
  @IsString()
  @IsNotEmpty()
  pid: string;

  // recall = thu hồi cả 2 phía; delete = xoá phía mình
  @IsIn(['recall', 'delete'])
  action: 'recall' | 'delete';

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class ThreadQueryDto {
  @IsString()
  @IsNotEmpty()
  pagePid: string;

  @IsString()
  @IsNotEmpty()
  tid: string;

  @IsOptional()
  @IsString()
  before?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  isGroup?: string;
}

export class MediaQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string;
}

export class DeliveryBookingDto {
  // 1 hóa đơn (cũ) hoặc nhiều hóa đơn gộp 1 tin (người nhận 1, 2…)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  invoiceId?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Type(() => Number)
  @IsInt({ each: true })
  invoiceIds?: number[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}
