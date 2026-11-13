import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  RegisterPushDeviceDto,
  UnregisterPushDeviceDto,
} from './dto/push-device.dto';
import { PushService } from './push.service';

/** Điện thoại (app mobile) đăng ký / hủy nhận thông báo đẩy cho user đang đăng nhập. */
@ApiTags('Push devices')
@Controller('push-devices')
export class PushController {
  constructor(private pushService: PushService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Đăng ký điện thoại nhận thông báo đẩy' })
  register(
    @CurrentUser() user: { id: number },
    @Body() dto: RegisterPushDeviceDto,
  ) {
    return this.pushService.register(user.id, dto.token, dto.platform);
  }

  @Post('unregister')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ngừng nhận thông báo đẩy trên điện thoại này' })
  unregister(
    @CurrentUser() user: { id: number },
    @Body() dto: UnregisterPushDeviceDto,
  ) {
    return this.pushService.unregister(user.id, dto.token);
  }
}
