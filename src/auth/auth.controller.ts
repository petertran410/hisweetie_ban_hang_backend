import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  UseGuards,
  Request,
  Req,
  Res,
  Query,
  ForbiddenException,
  HttpCode,
  Delete,
  Param,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request as ExpressRequest, Response } from 'express';
import {
  clearRefreshCookie,
  issueLarkNonce,
  readRefreshCookie,
  sessionContext,
  setRefreshCookie,
  takeLarkNonce,
} from './auth-cookie.util';
import { isCorsOriginAllowed } from '../common/cors-origin.util';
import { SessionService } from './session/session.service';
import { AuthService } from './auth.service';
import { LarkAuthService } from './lark-auth.service';
import { LarkSetupPasswordDto } from './dto/lark-setup-password.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from './decorators/public.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private larkAuthService: LarkAuthService,
    private sessionService: SessionService,
  ) {}

  /**
   * Endpoint dùng cookie phải được gọi từ chính FE (chặn CSRF từ subdomain
   * khác cùng site). Trình duyệt luôn gửi Origin với POST bằng fetch.
   */
  private assertTrustedOrigin(req: ExpressRequest) {
    const origin = req.headers.origin;
    if (!origin || !isCorsOriginAllowed(origin)) {
      throw new ForbiddenException('Origin không hợp lệ');
    }
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login' })
  async login(
    @Body() data: LoginDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Chặn trang khác gửi form đăng nhập hộ (login CSRF).
    this.assertTrustedOrigin(req);
    const { refresh, ...body } = await this.authService.login(
      data.email,
      data.password,
      undefined,
      sessionContext(req, res),
    );
    setRefreshCookie(res, refresh);
    return body;
  }

  /** Lấy access token mới bằng refresh token (cookie HttpOnly), xoay vòng token. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    try {
      const { refresh, ...body } = await this.authService.refresh(
        readRefreshCookie(req) ?? '',
        sessionContext(req, res),
      );
      if (refresh) setRefreshCookie(res, refresh);
      return body;
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout (revoke refresh token)' })
  async logout(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    await this.sessionService.revokeByToken(readRefreshCookie(req), 'logout');
    clearRefreshCookie(res);
    return { ok: true };
  }

  /** `sid` (phiên/thiết bị) trong access token của request hiện tại. */
  private currentSessionId(req: ExpressRequest): number | undefined {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const sid = token ? this.authService.decodeToken(token)?.sid : undefined;
    return typeof sid === 'number' ? sid : undefined;
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Thiết bị đang đăng nhập của tôi' })
  listMySessions(@Req() req: ExpressRequest & { user: { id: number } }) {
    return this.authService.listDevices(
      req.user.id,
      this.currentSessionId(req),
    );
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đăng xuất 1 thiết bị của tôi' })
  async revokeMySession(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: ExpressRequest & { user: { id: number } },
  ) {
    const ok = await this.sessionService.revokeSession(req.user.id, id);
    if (!ok) throw new NotFoundException('Không tìm thấy thiết bị');
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đăng xuất mọi thiết bị khác' })
  async revokeOtherSessions(
    @Req() req: ExpressRequest & { user: { id: number } },
  ) {
    const count = await this.sessionService.revokeOtherSessions(
      req.user.id,
      this.currentSessionId(req),
    );
    return { ok: true, count };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('lark')
  @ApiOperation({ summary: 'Lark OAuth QR login' })
  startLarkLogin(@Query('return_to') returnTo: string, @Res() res: Response) {
    const nonce = issueLarkNonce(res);
    const url = this.larkAuthService.buildAuthorizeUrl(returnTo, nonce);
    return res.redirect(url);
  }

  @Public()
  @Get('lark/callback')
  @ApiOperation({ summary: 'Lark OAuth callback' })
  async larkCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const { url, refresh } = await this.larkAuthService.handleCallback(
      code,
      state,
      sessionContext(req, res),
      takeLarkNonce(req, res),
    );
    // Token KHÔNG đi trên URL: refresh token nằm trong cookie HttpOnly, FE gọi
    // /auth/refresh để lấy access token.
    if (refresh) setRefreshCookie(res, refresh);
    return res.redirect(url);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('lark/setup-password')
  @ApiOperation({ summary: 'Set password after first Lark QR login' })
  async setupLarkPassword(
    @Body() data: LarkSetupPasswordDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    const { refresh, ...body } = await this.larkAuthService.setupPassword(
      data,
      sessionContext(req, res),
    );
    setRefreshCookie(res, refresh);
    return body;
  }

  @Public()
  @SkipThrottle()
  @Post('lark/events')
  @ApiOperation({ summary: 'Lark event webhook' })
  handleLarkEvent(@Req() req, @Body() body: Record<string, unknown>) {
    return this.larkAuthService.handleEvent(body, req.headers);
  }

  @Get('profile')
  async getProfile(@Req() req, @Query('branchId') branchId?: string) {
    const parsedBranchId = branchId ? parseInt(branchId) : undefined;
    return this.authService.getProfile(req.user.id, parsedBranchId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Put('profile')
  @ApiOperation({ summary: 'Update profile' })
  updateProfile(@Request() req, @Body() data: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, data);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Put('change-password')
  @ApiOperation({ summary: 'Change password' })
  changePassword(@Request() req, @Body() data: ChangePasswordDto) {
    return this.authService.changePassword(
      req.user.id,
      data.oldPassword,
      data.newPassword,
    );
  }
}
