import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { SecurityAuditService } from '../audit-logs/security-audit.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IncomingHttpHeaders } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  deriveJwtSecret,
  JWT_ALGORITHM,
  JWT_ISSUER,
  LARK_TOKEN_AUDIENCE,
} from './jwt-secret.util';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { IssuedRefresh, SessionContext } from './session/session.service';
import { ApprovalLifecycleService } from '../approval-lifecycle/approval-lifecycle.service';
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

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

/** Băm nonce trong state phải khớp cookie của trình duyệt (so sánh hằng thời gian). */
function sameNonce(expectedHash?: string, nonce?: string): boolean {
  if (!expectedHash || !nonce) return false;
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(sha256(nonce));
  return a.length === b.length && timingSafeEqual(a, b);
}

type LarkShellUser = {
  id: number;
  email: string;
  name: string;
  password: string | null;
  googleId: string | null;
  isActive: boolean;
  larkUserId: string | null;
};

/** Handler event Lark trả giá trị này để phân biệt với xác thực thất bại. */
const HANDLED = 'handled';

@Injectable()
export class LarkAuthService {
  private readonly logger = new Logger(LarkAuthService.name);
  private eventDispatcher: lark.EventDispatcher | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    private readonly approvalLifecycle: ApprovalLifecycleService,
    @Optional() private readonly securityAudit?: SecurityAuditService,
  ) {}

  /** Khoá riêng cho state/setup token (không dùng chung khoá access token). */
  private larkSecret(): string {
    this.larkTokenSecret ??= deriveJwtSecret('lark-oauth', this.config);
    return this.larkTokenSecret;
  }
  private larkTokenSecret?: string;

  private larkSignOptions() {
    return {
      secret: this.larkSecret(),
      issuer: JWT_ISSUER,
      audience: LARK_TOKEN_AUDIENCE,
    };
  }

  /** Ghi đè luật access token mặc định của JwtModule: khoá + `aud` riêng. */
  private larkVerifyOptions() {
    return {
      secret: this.larkSecret(),
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: LARK_TOKEN_AUDIENCE,
    };
  }

  /**
   * `nonce` = giá trị cookie HttpOnly vừa đặt cho trình duyệt này; state chỉ
   * mang băm của nó. Callback phải nhận lại đúng cookie đó mới đăng nhập.
   */
  buildAuthorizeUrl(returnTo: string | undefined, nonce: string): string {
    const oauth = this.getOAuthConfig();
    const state = this.jwtService.sign(
      {
        typ: STATE_TYP,
        returnTo: safeReturnTo(returnTo),
        nh: sha256(nonce),
      },
      { expiresIn: '10m', ...this.larkSignOptions() },
    );
    return buildAuthorizationUrl(oauth, state);
  }

  async handleCallback(
    code?: string,
    state?: string,
    ctx?: SessionContext,
    nonce?: string,
  ): Promise<{ url: string; refresh?: IssuedRefresh }> {
    const frontend = this.frontendLoginUrl();
    if (!code || !state) {
      return this.redirectOnly(frontend, {
        lark_error: 'Thiếu mã xác thực Lark',
      });
    }

    let returnTo = '/';
    try {
      const payload = this.jwtService.verify<{
        typ?: string;
        returnTo?: string;
        nh?: string;
      }>(state, this.larkVerifyOptions());
      if (payload.typ !== STATE_TYP || !sameNonce(payload.nh, nonce)) {
        return this.redirectOnly(frontend, {
          lark_error: 'Phiên đăng nhập Lark không hợp lệ. Vui lòng thử lại',
        });
      }
      returnTo = safeReturnTo(payload.returnTo);
    } catch {
      return this.redirectOnly(frontend, {
        lark_error: 'Phiên đăng nhập Lark đã hết hạn',
      });
    }

    try {
      const { user } = await exchangeCode(this.getOAuthConfig(), code);
      const result = await this.completeLarkLogin(user, ctx);
      if (result.mode === 'setup') {
        return this.redirectOnly(frontend, {
          lark_setup: result.token,
          return_to: returnTo,
        });
      }
      // Không đưa token lên URL: refresh token được controller set vào cookie
      // HttpOnly, FE gọi /auth/refresh để lấy access token.
      return {
        url: this.hashRedirect(frontend, {
          lark_ok: '1',
          return_to: returnTo,
        }),
        refresh: result.refresh,
      };
    } catch (err) {
      const message =
        err instanceof UnauthorizedException ||
        err instanceof BadRequestException
          ? err.message
          : 'Đăng nhập Lark thất bại';
      this.logger.warn(`Lark callback failed: ${message}`);
      return this.redirectOnly(frontend, {
        lark_error: message,
        return_to: returnTo,
      });
    }
  }

  async setupPassword(
    input: {
      setupToken: string;
      password: string;
      confirmPassword: string;
    },
    ctx?: SessionContext,
  ) {
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
        this.larkVerifyOptions(),
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
    // Token đặt mật khẩu chỉ dùng được 1 lần: chỉ ghi khi user CHƯA có mật khẩu
    // (điều kiện nằm trong câu UPDATE → 2 request cùng lúc cũng chỉ 1 cái qua).
    // Tăng permissionVersion → phiên cũ (nếu có) phải đăng nhập lại.
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, password: null },
      data: {
        password: hashedPassword,
        permissionVersion: { increment: 1 },
      },
    });
    if (count === 0) {
      throw new UnauthorizedException(
        'Tài khoản đã có mật khẩu. Vui lòng đăng nhập lại.',
      );
    }

    const response = await this.authService.issueAuthResponse(
      user.id,
      undefined,
      ctx,
    );
    this.securityAudit?.record('AUTH_PASSWORD_CHANGE', {
      userId: user.id,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      params: { method: 'đặt lần đầu qua Lark' },
    });
    this.authService.recordLogin?.(user.id, 'Lark', ctx);
    return response;
  }

  async handleEvent(
    body: Record<string, unknown>,
    headers: IncomingHttpHeaders = {},
  ) {
    const encryptKey = this.config.get<string>('LARK_ENCRYPT_KEY') || '';
    const verificationToken =
      this.config.get<string>('LARK_VERIFICATION_TOKEN') || '';

    // SDK reads signature headers from the prototype so JSON.stringify(body)
    // still matches the raw payload Lark signed.
    const payload = Object.assign(Object.create({ headers }), body);

    const challenge = lark.generateChallenge(payload, { encryptKey });
    if (challenge.isChallenge) {
      return challenge.challenge;
    }

    const dispatcher = this.getEventDispatcher(encryptKey, verificationToken);
    // SDK trả undefined khi xác thực thất bại; các handler luôn trả HANDLED.
    const result = await dispatcher.invoke(payload);
    if (result === undefined) {
      this.logger.warn('Lark event verification failed');
    }
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
    ctx?: SessionContext,
  ): Promise<
    | { mode: 'setup'; token: string }
    | { mode: 'session'; refresh: IssuedRefresh }
  > {
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

    const session = await this.authService.issueAuthResponse(
      user.id,
      undefined,
      ctx,
    );
    this.authService.recordLogin?.(user.id, 'Lark', ctx);
    return { mode: 'session', refresh: session.refresh };
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
      { expiresIn: '15m', ...this.larkSignOptions() },
    );
  }

  private getOAuthConfig(): LarkOAuthConfig {
    const appId = (this.config.get<string>('LARK_APP_ID') || '').trim();
    const appSecret = (this.config.get<string>('LARK_APP_SECRET') || '').trim();
    const redirectUri = (
      this.config.get<string>('LARK_OAUTH_REDIRECT_URI') ||
      'http://localhost:3060/api/auth/lark/callback'
    ).trim();
    const domain = (this.config.get<string>('LARK_DOMAIN') || 'larksuite.com')
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    if (!appId || !appSecret) {
      throw new BadRequestException(
        'LARK_APP_ID hoặc LARK_APP_SECRET chưa được cấu hình',
      );
    }
    if (!redirectUri) {
      throw new BadRequestException(
        'LARK_OAUTH_REDIRECT_URI chưa được cấu hình',
      );
    }

    return { appId, appSecret, domain, redirectUri };
  }

  private frontendLoginUrl(): string {
    const frontend = (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3050'
    ).replace(/\/$/, '');
    return `${frontend}/login`;
  }

  private redirectOnly(
    loginUrl: string,
    params: Record<string, string | undefined>,
  ): { url: string } {
    return { url: this.hashRedirect(loginUrl, params) };
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
        return HANDLED;
      },
      approval_instance: async (data) => {
        const event = (data as any)?.event || data;
        await this.approvalLifecycle.handleInstanceEvent(event as any);
        return HANDLED;
      },
      // Lark gửi kèm các event này; POS không dùng, nhận để khỏi báo "no handle".
      approval: async () => HANDLED,
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => HANDLED,
    });
    return this.eventDispatcher;
  }
}
