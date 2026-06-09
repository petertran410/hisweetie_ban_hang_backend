import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { NotificationQueryDto } from './dto/notification-query.dto';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách thông báo của user (phân trang cursor)' })
  list(@CurrentUser() user: any, @Query() query: NotificationQueryDto) {
    return this.notificationsService.listForUser(user.id, {
      cursor: query.cursor ? Number(query.cursor) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Số thông báo chưa đọc (cho badge)' })
  async unreadCount(@CurrentUser() user: any) {
    const count = await this.notificationsService.countUnread(user.id);
    return { count };
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Đánh dấu 1 thông báo đã đọc' })
  markRead(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.notificationsService.markRead(user.id, id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Đánh dấu tất cả thông báo đã đọc' })
  markAllRead(@CurrentUser() user: any) {
    return this.notificationsService.markAllRead(user.id);
  }
}
