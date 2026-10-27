import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import {
  ChatActor,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  SmaxChatService,
} from './smax-chat.service';
import {
  ChatMessagesQueryDto,
  MediaQueryDto,
  CreateZaloContactDto,
  ReactMessageDto,
  FriendActionDto,
  SendChatMessageDto,
  SendThreadMessageDto,
  ThreadQueryDto,
  SharedGroupsQueryDto,
  UpdateZaloContactDto,
  ZaloProfileQueryDto,
  ZaloLookupQueryDto,
} from './dto/smax-chat.dto';

@ApiTags('Smax Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('smax/chat')
export class SmaxChatController {
  constructor(private readonly service: SmaxChatService) {}

  private actor(req: any): ChatActor {
    return {
      id: req.user.id,
      name: req.user.name,
      canViewOtherStaffData: req.user.canViewOtherStaffData,
      canViewDebt: requestHasPermission(req, 'customers:view_debt'),
      canViewPackingSlips: requestHasPermission(req, 'packing_slips:view'),
    };
  }

  // Tải ảnh/tệp Zalo (chỉ host Zalo) — dùng cho "Tải xuống" / chọn nhiều
  @Get('media')
  @RequirePermissions('smax_chat:view')
  async media(@Query() q: MediaQueryDto, @Res() res: any) {
    const { body, contentType } = await this.service.fetchZaloMedia(q.url);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(body);
  }

  @Get('channels')
  @RequirePermissions('smax_chat:view')
  channels(@Req() req: any) {
    return this.service.myChannels(req.user.id);
  }

  // Hội thoại chưa gắn khách POS (mở từ "Đang chat gần đây")
  @Get('threads/messages')
  @RequirePermissions('smax_chat:view')
  threadMessages(@Query() q: ThreadQueryDto, @Req() req: any) {
    return this.service.getThreadMessages(req.user.id, q.pagePid, q.tid, q.before);
  }

  @Get('threads/profile')
  @RequirePermissions('smax_chat:view')
  threadProfile(@Query() q: ThreadQueryDto, @Req() req: any) {
    return this.service.getThreadProfile(req.user.id, q.pagePid, q.tid, q.isGroup === 'true');
  }

  @Post('threads/messages')
  @RequirePermissions('smax_chat:send')
  sendToThread(@Body() dto: SendThreadMessageDto, @Req() req: any) {
    return this.service.sendToThread(this.actor(req), dto);
  }

  // Thả / thu hồi cảm xúc (API nội bộ Smax, cần SMAX_USER_TOKEN)
  @Post('threads/reaction')
  @RequirePermissions('smax_chat:send')
  react(@Body() dto: ReactMessageDto, @Req() req: any) {
    return this.service.reactMessage(this.actor(req), dto);
  }

  @Get('recent')
  @RequirePermissions('smax_chat:view')
  recent(@Req() req: any, @Query('pagePid') pagePid?: string) {
    return this.service.recentChats(req.user.id, pagePid || undefined);
  }

  @Get('customers/:id/context')
  @RequirePermissions('smax_chat:view')
  getContext(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.getContext(id, this.actor(req));
  }

  @Get('customers/:id/messages')
  @RequirePermissions('smax_chat:view')
  getMessages(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ChatMessagesQueryDto,
    @Req() req: any,
  ) {
    return this.service.getMessages(
      id,
      this.actor(req),
      query.pagePid,
      query.contactId,
      query.before,
    );
  }

  @Post('attachments')
  @RequirePermissions('smax_chat:send')
  @UseInterceptors(
    FilesInterceptor('files', MAX_ATTACHMENTS, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  uploadAttachments(@UploadedFiles() files: Express.Multer.File[]) {
    return this.service.uploadAttachments(files);
  }

  @Get('customers/:id/zalo-profile')
  @RequirePermissions('smax_chat:view')
  zaloProfile(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ZaloProfileQueryDto,
    @Req() req: any,
  ) {
    return this.service.getZaloProfile(id, req.user.id, query.pagePid, query.contactId);
  }

  @Post('customers/:id/friend')
  @RequirePermissions('smax_chat:send')
  friendAction(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FriendActionDto,
    @Req() req: any,
  ) {
    return this.service.friendAction(id, this.actor(req), dto);
  }

  @Post('customers/:id/messages')
  @RequirePermissions('smax_chat:send')
  send(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendChatMessageDto,
    @Req() req: any,
  ) {
    return this.service.sendMessage(id, this.actor(req), dto);
  }

  @Get('customers/:id/payment-info')
  @RequirePermissions('smax_chat:view')
  paymentInfo(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.getPaymentInfo(id, this.actor(req));
  }

  @Get('customers/:id/shared-groups')
  @RequirePermissions('smax_chat:view')
  sharedGroups(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SharedGroupsQueryDto,
    @Req() req: any,
  ) {
    return this.service.scanSharedGroups(
      id,
      req.user.id,
      query.pagePid,
      query.refresh === 'true',
    );
  }

  @Post('customers/:id/contacts')
  @RequirePermissions('smax_chat:manage_contacts')
  createContact(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateZaloContactDto,
    @Req() req: any,
  ) {
    return this.service.createContact(id, req.user.id, dto);
  }

  @Patch('customers/:id/contacts/:contactId')
  @RequirePermissions('smax_chat:manage_contacts')
  updateContact(
    @Param('id', ParseIntPipe) id: number,
    @Param('contactId', ParseIntPipe) contactId: number,
    @Body() dto: UpdateZaloContactDto,
  ) {
    return this.service.updateContact(id, contactId, dto);
  }

  @Delete('customers/:id/contacts/:contactId')
  @RequirePermissions('smax_chat:manage_contacts')
  deleteContact(
    @Param('id', ParseIntPipe) id: number,
    @Param('contactId', ParseIntPipe) contactId: number,
  ) {
    return this.service.deleteContact(id, contactId);
  }

  @Get('zalo-lookup')
  @RequirePermissions('smax_chat:manage_contacts')
  lookup(@Query() query: ZaloLookupQueryDto, @Req() req: any) {
    return this.service.lookupByPhone(req.user.id, query.pagePid, query.phone);
  }
}
