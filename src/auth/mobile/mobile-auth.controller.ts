import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { LarkAuthService } from '../lark-auth.service';
import { SessionService } from '../session/session.service';
import { issueLarkNonce } from '../auth-cookie.util';
import { Public } from '../decorators/public.decorator';
import { LoginDto } from '../dto/login.dto';
import { LarkSetupPasswordDto } from '../dto/lark-setup-password.dto';
import { MobileLarkExchangeDto, MobileRefreshDto } from './mobile-auth.dto';
import { mobileSessionContext, toMobileAuthBody } from './mobile-session.util';

/**
 * Đăng nhập cho app iOS (React Native). Khác bản web:
 * - refresh token trả trong body, app tự giữ trong Keychain (không cookie);
 * - không kiểm Origin: app native không gửi Origin, và không dùng cookie nên
 *   không có nguy cơ CSRF;
 * - mã thiết bị đi qua header `X-Device-Id`.
 */
@ApiTags('Authentication (iOS app)')
@Controller('auth/mobile')
export class MobileAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly larkAuthService: LarkAuthService,
    private readonly sessionService: SessionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'App: đăng nhập email + mật khẩu' })
  async login(@Body() data: LoginDto, @Req() req: Request) {
    const ctx = mobileSessionContext(req);
    const response = await this.authService.login(
      data.email,
      data.password,
      undefined,
      ctx,
    );
    return toMobileAuthBody(response);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'App: đổi refresh token lấy token mới' })
  async refresh(@Body() data: MobileRefreshDto, @Req() req: Request) {
    const { refresh, ...body } = await this.authService.refresh(
      data.refreshToken,
      mobileSessionContext(req),
      { reissueOnGrace: true },
    );
    return {
      ...body,
      // Thiếu = app giữ nguyên refresh token đang có.
      ...(refresh
        ? {
            refreshToken: refresh.token,
            refreshExpiresAt: refresh.expiresAt.toISOString(),
          }
        : {}),
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'App: đăng xuất (thu hồi phiên của máy này)' })
  async logout(@Body() data: MobileRefreshDto) {
    await this.sessionService.revokeOwnSession(data.refreshToken, 'logout');
    return { ok: true };
  }

  /**
   * App mở URL này trong ASWebAuthenticationSession. Lark xong sẽ quay về
   * callback chung của backend, rồi về `redirect_uri` của app kèm `?code=`.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('lark')
  @ApiOperation({ summary: 'App: bắt đầu đăng nhập Lark (PKCE)' })
  startLarkLogin(
    @Query('redirect_uri') redirectUri: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Res() res: Response,
  ) {
    const nonce = issueLarkNonce(res);
    const url = this.larkAuthService.buildMobileAuthorizeUrl(
      { redirectUri, codeChallenge, codeChallengeMethod },
      nonce,
    );
    return res.redirect(url);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('lark/exchange')
  @HttpCode(200)
  @ApiOperation({ summary: 'App: đổi mã Lark một lần lấy phiên đăng nhập' })
  async exchangeLarkCode(
    @Body() data: MobileLarkExchangeDto,
    @Req() req: Request,
  ) {
    // Kiểm mã thiết bị TRƯỚC khi đổi mã (mã chỉ dùng được 1 lần).
    const ctx = mobileSessionContext(req);
    const result = await this.larkAuthService.exchangeMobileCode(
      data.code,
      data.codeVerifier,
      ctx,
    );
    return 'setupToken' in result
      ? { setupToken: result.setupToken }
      : toMobileAuthBody(result.session);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('lark/setup-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'App: đặt mật khẩu sau lần đầu đăng nhập Lark' })
  async setupLarkPassword(
    @Body() data: LarkSetupPasswordDto,
    @Req() req: Request,
  ) {
    const response = await this.larkAuthService.setupPassword(
      data,
      mobileSessionContext(req),
    );
    return toMobileAuthBody(response);
  }
}
