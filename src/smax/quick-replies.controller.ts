import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import { CreateQuickReplyDto, UpdateQuickReplyDto } from './dto/quick-reply.dto';
import { QuickRepliesService, QuickReplyActor } from './quick-replies.service';

/** Tin nhắn nhanh sidechat — ai gửi được tin Zalo thì dùng và tự quản lý tin riêng của mình. */
@ApiTags('Smax Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('smax/chat/quick-replies')
export class QuickRepliesController {
  constructor(private readonly service: QuickRepliesService) {}

  private actor(req: any): QuickReplyActor {
    return {
      id: req.user.id,
      name: req.user.name,
      canManageShared: requestHasPermission(req, 'smax_chat:manage_quick_replies'),
    };
  }

  @Get()
  @RequirePermissions('smax_chat:send')
  list(@Req() req: any) {
    return this.service.list(this.actor(req));
  }

  @Post()
  @RequirePermissions('smax_chat:send')
  create(@Body() dto: CreateQuickReplyDto, @Req() req: any) {
    return this.service.create(this.actor(req), dto);
  }

  @Patch(':id')
  @RequirePermissions('smax_chat:send')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateQuickReplyDto, @Req() req: any) {
    return this.service.update(this.actor(req), id, dto);
  }

  @Delete(':id')
  @RequirePermissions('smax_chat:send')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(this.actor(req), id);
  }
}
