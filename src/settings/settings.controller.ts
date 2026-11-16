import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { TestLarkNotifyDto, UpdateSettingsDto } from './dto';
import { LarkCustomerNotificationService } from '../lark-sync/services/lark-customer-notification.service';

@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private settingsService: SettingsService,
    private larkCustomerNotification: LarkCustomerNotificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get system settings' })
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Put()
  @RequirePermissions('settings:update')
  @ApiOperation({ summary: 'Update system settings' })
  updateSettings(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    return this.settingsService.updateSettings(dto, req.user?.id);
  }

  @Get('lark-recipients')
  @RequirePermissions('settings:update')
  @ApiOperation({
    summary: 'Người dùng đã gắn Lark (chọn người nhận thông báo)',
  })
  getLarkRecipients() {
    return this.settingsService.getLarkRecipients();
  }

  @Post('lark-notify/test')
  @RequirePermissions('settings:update')
  @ApiOperation({
    summary: 'Gửi thử tin đổi MST / tạo thử task KH mới trên Lark',
  })
  testLarkNotify(@Body() dto: TestLarkNotifyDto, @Req() req: any) {
    return this.larkCustomerNotification.sendTest(dto.kind, req.user?.id);
  }
}
