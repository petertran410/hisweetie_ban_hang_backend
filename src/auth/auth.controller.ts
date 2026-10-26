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
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request as ExpressRequest, Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshCookie,
  sessionContext,
  setRefreshCookie,
} from './auth-cookie.util';
import { isCorsOriginAllowed } from '../common/cors-origin.util';
import { SessionService } from './session/session.service';
import { AuthService } from './auth.service';
import { LarkAuthService } from './lark-auth.service';
import { LarkSetupPasswordDto } from './dto/lark-setup-password.dto';
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
    @Body() data: { email: string; password: string },
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refresh, ...body } = await this.authService.login(
      data.email,
      data.password,
      undefined,
      sessionContext(req),
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
        sessionContext(req),
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

  /**
   * Chuyển phiên Bearer 7 ngày cũ (lưu ở localStorage) sang refresh token
   * cookie — người đang đăng nhập không phải đăng nhập lại. Chỉ nhận token cũ.
   */
  @Post('session/migrate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Migrate legacy bearer session to refresh cookie' })
  async migrateSession(
    @Req() req: ExpressRequest & { user: { id: number } },
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const payload = token ? this.authService.decodeToken(token) : null;
    if (!payload || payload.sid !== undefined) {
      throw new BadRequestException('Phiên đã ở định dạng mới');
    }
    const { refresh, ...body } = await this.authService.migrateLegacySession(
      req.user.id,
      sessionContext(req),
    );
    setRefreshCookie(res, refresh);
    return body;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('lark')
  @ApiOperation({ summary: 'Lark OAuth QR login' })
  startLarkLogin(@Query('return_to') returnTo: string, @Res() res: Response) {
    const url = this.larkAuthService.buildAuthorizeUrl(returnTo);
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
      sessionContext(req),
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
    const { refresh, ...body } = await this.larkAuthService.setupPassword(
      data,
      sessionContext(req),
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
  updateProfile(
    @Request() req,
    @Body() data: { name?: string; phone?: string; avatar?: string },
  ) {
    return this.authService.updateProfile(req.user.id, data);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Put('change-password')
  @ApiOperation({ summary: 'Change password' })
  changePassword(
    @Request() req,
    @Body() data: { oldPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(
      req.user.id,
      data.oldPassword,
      data.newPassword,
    );
  }
}
