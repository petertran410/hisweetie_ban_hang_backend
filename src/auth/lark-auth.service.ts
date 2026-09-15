import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import {
  buildAuthorizationUrl,
  exchangeCode,
  pickLarkDisplayName,
  pickPreferredEmail,
  safeReturnTo,
  type LarkOAuthConfig,
  type LarkUserProfile,
} from './lark-oauth.util';

const SETUP_TYP = 'lark_setup';
const STATE_TYP = 'lark_oauth_state';
const MIN_PASSWORD_LENGTH = 8;

type LarkShellUser = {
  id: number;
  email: string;
  name: string;
  password: string | null;
  googleId: string | null;
  isActive: boolean;
  larkUserId: string | null;
};

@Injectable()
export class LarkAuthService {
  private readonly logger = new Logger(LarkAuthService.name);
  private eventDispatcher: lark.EventDispatcher | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  buildAuthorizeUrl(returnTo?: string): string {
    const oauth = this.getOAuthConfig();
    const state = this.jwtService.sign(
      {
        typ: STATE_TYP,
        returnTo: safeReturnTo(returnTo),
      },
      { expiresIn: '10m' },
    );
    return buildAuthorizationUrl(oauth, state);
  }

  async handleCallback(code?: string, state?: string): Promise<string> {
    const frontend = this.frontendLoginUrl();
    if (!code || !state) {
      return this.hashRedirect(frontend, { lark_error: 'Thiếu mã xác thực Lark' });
    }

    let returnTo = '/';
    try {
      const payload = this.jwtService.verify<{ typ?: string; returnTo?: string }>(
        state,
      );
      if (payload.typ !== STATE_TYP) {
        return this.hashRedirect(frontend, { lark_error: 'Phiên đăng nhập Lark không hợp lệ' });
      }
      returnTo = safeReturnTo(payload.returnTo);
    } catch {
      return this.hashRedirect(frontend, {
        lark_error: 'Phiên đăng nhập Lark đã hết hạn',
      });
    }

    try {
      const { user } = await exchangeCode(this.getOAuthConfig(), code);
      const result = await this.completeLarkLogin(user);
      if (result.mode === 'setup') {
        return this.hashRedirect(frontend, {
          lark_setup: result.token,
          return_to: returnTo,
        });
      }
      return this.hashRedirect(frontend, {
        lark_token: result.token,
        return_to: returnTo,
      });
    } catch (err) {
      const message =
        err instanceof UnauthorizedException || err instanceof BadRequestException
          ? err.message
          : 'Đăng nhập Lark thất bại';
      this.logger.warn(`Lark callback failed: ${message}`);
      return this.hashRedirect(frontend, { lark_error: message, return_to: returnTo });
    }
  }

  async setupPassword(input: {
    setupToken: string;
    password: string;
    confirmPassword: string;
  }) {
    const password = (input.password || '').trim();
    const confirmPassword = (input.confirmPassword || '').trim();
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException('Mật khẩu phải có ít nhất 8 ký tự');
    }
    if (password !== confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    let uid: number;
    try {
      const payload = this.jwtService.verify<{ typ?: string; uid?: number }>(
        input.setupToken,
      );
      if (payload.typ !== SETUP_TYP || !payload.uid) {
        throw new UnauthorizedException('Phiên đặt mật khẩu không hợp lệ');
      }
      uid = payload.uid;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Phiên đặt mật khẩu đã hết hạn');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Tài khoản không hợp lệ');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    return this.authService.issueAuthResponse(user.id);
  }

  async handleEvent(body: Record<string, unknown>) {
    const encryptKey = this.config.get<string>('LARK_ENCRYPT_KEY') || '';
    const verificationToken =
      this.config.get<string>('LARK_VERIFICATION_TOKEN') || '';

    const challenge = lark.generateChallenge(body, { encryptKey });
    if (challenge.isChallenge) {
      return challenge.challenge;
    }

    const dispatcher = this.getEventDispatcher(encryptKey, verificationToken);
    await dispatcher.invoke(body);
    return { ok: true };
  }

  async provisionFromContactCreated(object?: {
    open_id?: string;
    name?: string;
    en_name?: string;
    email?: string;
    enterprise_email?: string;
    mobile?: string;
    avatar?: { avatar_origin?: string };
  }): Promise<'created' | 'skipped'> {
    const openId = (object?.open_id || '').trim();
    if (!openId) {
      this.logger.warn('Skip Lark user.created: missing open_id');
      return 'skipped';
    }

    const existingByLark = await this.prisma.user.findUnique({
      where: { larkUserId: openId },
      select: { id: true },
    });
    if (existingByLark) {
      return 'skipped';
    }

    const email = pickPreferredEmail(object?.enterprise_email, object?.email);
    if (!email) {
      this.logger.warn(`Skip Lark user.created ${openId}: missing email`);
      return 'skipped';
    }

    const existingByEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingByEmail) {
      this.logger.warn(
        `Skip Lark user.created ${openId}: email ${email} already exists`,
      );
      return 'skipped';
    }

    try {
      await this.prisma.user.create({
        data: {
          name: pickLarkDisplayName({
            name: object?.name,
            en_name: object?.en_name,
            email: object?.email,
            enterprise_email: object?.enterprise_email,
          }),
          email,
          larkUserId: openId,
          phone: object?.mobile || null,
          avatar: object?.avatar?.avatar_origin || null,
          isActive: false,
        },
      });
      this.logger.log(`Provisioned inactive POS user for Lark ${openId}`);
      return 'created';
    } catch (err: any) {
      if (err?.code === 'P2002') {
        this.logger.warn(`Skip Lark user.created ${openId}: unique conflict`);
        return 'skipped';
      }
      throw err;
    }
  }

  async completeLarkLogin(
    profile: LarkUserProfile,
  ): Promise<{ mode: 'setup' | 'session'; token: string }> {
    const openId = (profile.open_id || '').trim();
    if (!openId) {
      throw new UnauthorizedException('Lark không trả về mã người dùng');
    }

    let user = await this.prisma.user.findUnique({
      where: { larkUserId: openId },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
        googleId: true,
        isActive: true,
        larkUserId: true,
      },
    });

    if (!user) {
      user = await this.createUserFromQr(profile, openId);
      return { mode: 'setup', token: this.signSetupToken(user.id) };
    }

    if (this.isOnboardingShell(user)) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { isActive: true },
        select: {
          id: true,
          email: true,
          name: true,
          password: true,
          googleId: true,
          isActive: true,
          larkUserId: true,
        },
      });
      return { mode: 'setup', token: this.signSetupToken(user.id) };
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị vô hiệu hóa');
    }

    if (!user.password) {
      return { mode: 'setup', token: this.signSetupToken(user.id) };
    }

    const session = await this.authService.issueAuthResponse(user.id);
    return { mode: 'session', token: session.accessToken };
  }

  private async createUserFromQr(
    profile: LarkUserProfile,
    openId: string,
  ): Promise<LarkShellUser> {
    const email = pickPreferredEmail(profile.enterprise_email, profile.email);
    if (!email) {
      throw new UnauthorizedException(
        'Tài khoản Lark không có email, không thể tạo user POS',
      );
    }

    const existingByEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingByEmail) {
      throw new UnauthorizedException(
        'Email đã tồn tại trên POS. Liên hệ admin để gắn Lark ID',
      );
    }

    try {
      return await this.prisma.user.create({
        data: {
          name: pickLarkDisplayName(profile),
          email,
          larkUserId: openId,
          phone: profile.mobile || null,
          avatar: profile.avatar_url || profile.avatar_big || null,
          isActive: true,
        },
        select: {
          id: true,
          email: true,
          name: true,
          password: true,
          googleId: true,
          isActive: true,
          larkUserId: true,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new UnauthorizedException(
          'Email hoặc Lark ID đã tồn tại. Liên hệ admin để gắn tài khoản',
        );
      }
      throw err;
    }
  }

  private isOnboardingShell(user: LarkShellUser): boolean {
    return !user.isActive && !user.password && !user.googleId;
  }

  private signSetupToken(userId: number): string {
    return this.jwtService.sign(
      { typ: SETUP_TYP, uid: userId },
      { expiresIn: '15m' },
    );
  }

  private getOAuthConfig(): LarkOAuthConfig {
    const appId = (this.config.get<string>('LARK_APP_ID') || '').trim();
    const appSecret = (this.config.get<string>('LARK_APP_SECRET') || '').trim();
    const redirectUri = (
      this.config.get<string>('LARK_OAUTH_REDIRECT_URI') ||
      'http://localhost:3060/api/auth/lark/callback'
    ).trim();
    const domain = (
      this.config.get<string>('LARK_DOMAIN') || 'larksuite.com'
    )
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    if (!appId || !appSecret) {
      throw new BadRequestException(
        'LARK_APP_ID hoặc LARK_APP_SECRET chưa được cấu hình',
      );
    }
    if (!redirectUri) {
      throw new BadRequestException('LARK_OAUTH_REDIRECT_URI chưa được cấu hình');
    }

    return { appId, appSecret, domain, redirectUri };
  }

  private frontendLoginUrl(): string {
    const frontend = (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
    return `${frontend}/login`;
  }

  private hashRedirect(
    loginUrl: string,
    params: Record<string, string | undefined>,
  ): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (!value) continue;
      search.set(key, value);
    }
    return `${loginUrl}#${search.toString()}`;
  }

  private getEventDispatcher(
    encryptKey: string,
    verificationToken: string,
  ): lark.EventDispatcher {
    if (this.eventDispatcher) return this.eventDispatcher;
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey,
      verificationToken,
    }).register({
      'contact.user.created_v3': async (data) => {
        await this.provisionFromContactCreated(data?.object);
      },
    });
    return this.eventDispatcher;
  }
}
