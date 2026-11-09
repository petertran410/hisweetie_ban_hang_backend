import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SmaxService } from './smax.service';
import { LinkSmaxChannelDto } from './dto/link-smax-channel.dto';
import { SmaxUserTokenDto } from './dto/smax-user-token.dto';

@ApiTags('Smax')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('smax')
export class SmaxController {
  constructor(private readonly service: SmaxService) {}

  @Get('zalo-channels')
  @RequirePermissions('settings:update')
  getZaloChannels() {
    return this.service.getZaloChannels();
  }

  // Tải lại kênh từ Smax và cập nhật tên kênh đã lưu của các liên kết
  @Post('zalo-channels/sync')
  @RequirePermissions('settings:update')
  sync() {
    return this.service.syncZaloChannels();
  }

  @Put('zalo-channels/:pagePid')
  @RequirePermissions('settings:update')
  link(@Param('pagePid') pagePid: string, @Body() dto: LinkSmaxChannelDto) {
    return this.service.link(pagePid, dto.userId);
  }

  // Token đăng nhập Smax (API nội bộ: thả cảm xúc, thu hồi, đổi tên, Thư viện…) — không trả nguyên token
  @Get('user-token')
  @RequirePermissions('settings:update')
  userTokenStatus() {
    return this.service.userTokenStatus();
  }

  @Put('user-token')
  @RequirePermissions('settings:update')
  setUserToken(@Body() dto: SmaxUserTokenDto, @Req() req: any) {
    return this.service.setUserToken(dto.token, { id: req.user.id, name: req.user.name });
  }

  @Delete('user-token')
  @RequirePermissions('settings:update')
  clearUserToken(@Req() req: any) {
    return this.service.clearUserToken({ id: req.user.id, name: req.user.name });
  }

  @Delete('zalo-channels/:pagePid')
  @RequirePermissions('settings:update')
  unlink(
    @Param('pagePid') pagePid: string,
    @Query('userId') userId?: string,
  ) {
    return this.service.unlink(pagePid, userId ? Number(userId) : undefined);
  }
}
