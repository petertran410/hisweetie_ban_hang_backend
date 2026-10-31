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
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
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
/** Mã một lần trả về app iOS sau khi Lark xác thực xong (đổi lấy token). */
const MOBILE_CODE_TYP = 'lark_mobile_code';
const MOBILE_CODE_TTL_SECONDS = 60;
/** PKCE S256: base64url(sha256(verifier)) luôn dài 43 ký tự. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43–128 ký tự không dấu. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const MIN_PASSWORD_LENGTH = 8;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

type LarkLoginMode = 'setup' | 'session';

/**
 * Băm trong token phải khớp giá trị bí mật client đang giữ (so sánh hằng thời
 * gian): nonce cookie của trình duyệt, hoặc code_verifier PKCE của app.
 */
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

  /** Khoá riêng cho mã một lần của app (không thay được state/setup token). */
  private mobileCodeSecret(): string {
    this.mobileCodeTokenSecret ??= deriveJwtSecret(
      'lark-mobile-code',
      this.config,
    );
    return this.mobileCodeTokenSecret;
  }
  private mobileCodeTokenSecret?: string;

  /**
   * jti của mã một lần đã đổi → hết hạn lúc nào. Chỉ trong bộ nhớ (backend
   * chạy 1 instance); mất khi deploy cũng không sao vì mã sống 60s và đổi mã
   * vẫn bắt buộc có code_verifier PKCE.
   */
  private readonly usedMobileCodes = new Map<string, number>();

  /** URI app được phép nhận mã (env `MOBILE_REDIRECT_URIS`, cách nhau dấu phẩy). */
  isAllowedMobileRedirect(uri?: string): boolean {
    if (!uri) return false;
    return (this.config.get<string>('MOBILE_REDIRECT_URIS') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(uri);
  }

  /**
   * Bắt đầu đăng nhập Lark từ app iOS (mở trong ASWebAuthenticationSession).
   * State mang thêm URI trả về + code_challenge PKCE; nonce cookie vẫn gắn
   * lượt đăng nhập với đúng phiên trình duyệt đó như bản web.
   */
  buildMobileAuthorizeUrl(
    input: {
      redirectUri?: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    },
    nonce: string,
  ): string {
    const ru = (input.redirectUri || '').trim();
    if (!this.isAllowedMobileRedirect(ru)) {
      throw new BadRequestException('redirect_uri không được phép');
    }
    const cc = (input.codeChallenge || '').trim();
    if (
      (input.codeChallengeMethod || 'S256') !== 'S256' ||
      !CODE_CHALLENGE_PATTERN.test(cc)
    ) {
      throw new BadRequestException('code_challenge không hợp lệ');
    }
    const oauth = this.getOAuthConfig();
    const state = this.jwtService.sign(
      {
        typ: STATE_TYP,
        returnTo: '/',
        nh: sha256(nonce),
        client: 'mobile',
        ru,
        cc,
      },
      { expiresIn: '10m', ...this.larkSignOptions() },
    );
    return buildAuthorizationUrl(oauth, state);
  }

  /**
   * URI app trong state (chỉ giải mã, chưa kiểm chữ ký) — dùng để báo lỗi về
   * app thay vì trang web. Luôn kiểm lại danh sách cho phép.
   */
  private mobileRedirectFromState(state?: string): string | undefined {
    if (!state) return undefined;
    try {
      const decoded = this.jwtService.decode<{
        client?: string;
        ru?: string;
      } | null>(state);
      const ru = decoded?.client === 'mobile' ? decoded.ru : undefined;
      return ru && this.isAllowedMobileRedirect(ru) ? ru : undefined;
    } catch {
      return undefined;
    }
  }

  private appRedirect(ru: string, params: Record<string, string>): string {
    const url = new URL(ru);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private signMobileCode(uid: number, mode: LarkLoginMode, cc: string) {
    return this.jwtService.sign(
      { typ: MOBILE_CODE_TYP, uid, mode, cc, jti: randomUUID() },
      {
        expiresIn: MOBILE_CODE_TTL_SECONDS,
        secret: this.mobileCodeSecret(),
        issuer: JWT_ISSUER,
        audience: LARK_TOKEN_AUDIENCE,
      },
    );
  }

  /**
   * App đổi mã một lần (kèm code_verifier PKCE) lấy phiên đăng nhập, hoặc lấy
   * setup token nếu user cần đặt mật khẩu lần đầu. Phiên được tạo với thông tin
   * thiết bị của app (không phải trình duyệt đăng nhập Lark).
   */
  async exchangeMobileCode(
    code: string,
    codeVerifier: string,
    ctx: SessionContext,
  ): Promise<
    | { setupToken: string }
    | { session: Awaited<ReturnType<AuthService['issueAuthResponse']>> }
  > {
    let payload: {
      typ?: string;
      uid?: number;
      mode?: LarkLoginMode;
      cc?: string;
      jti?: string;
      exp?: number;
    };
    try {
      payload = this.jwtService.verify(code, {
        secret: this.mobileCodeSecret(),
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: LARK_TOKEN_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException(
        'Mã đăng nhập Lark đã hết hạn. Vui lòng thử lại',
      );
    }
    if (
      payload.typ !== MOBILE_CODE_TYP ||
      !payload.uid ||
      !payload.jti ||
      (payload.mode !== 'setup' && payload.mode !== 'session') ||
      !CODE_VERIFIER_PATTERN.test(codeVerifier || '') ||
      !sameNonce(payload.cc, codeVerifier)
    ) {
      throw new UnauthorizedException('Mã đăng nhập Lark không hợp lệ');
    }
    // Chỉ "đốt" mã sau khi PKCE đúng: người không có verifier không làm hỏng
    // được lượt đăng nhập của app.
    this.consumeMobileCode(payload.jti, payload.exp);

    if (payload.mode === 'setup') {
      return { setupToken: this.signSetupToken(payload.uid) };
    }
    const session = await this.authService.issueAuthResponse(
      payload.uid,
      undefined,
      ctx,
    );
    this.authService.recordLogin?.(payload.uid, 'Lark', ctx);
    return { session };
  }

  private consumeMobileCode(jti: string, exp?: number) {
    const now = Date.now();
    for (const [key, until] of this.usedMobileCodes) {
      if (until < now) this.usedMobileCodes.delete(key);
    }
    if (this.usedMobileCodes.has(jti)) {
      throw new UnauthorizedException('Mã đăng nhập Lark đã được sử dụng');
    }
    const until = exp ? exp * 1000 : now + MOBILE_CODE_TTL_SECONDS * 1000;
    this.usedMobileCodes.set(jti, until + 1000);
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
    // Lượt đăng nhập bắt đầu từ app iOS: mọi kết quả trả về URI của app.
    const mobileRu = this.mobileRedirectFromState(state);
    const fail = (message: string, returnTo?: string): { url: string } =>
      mobileRu
        ? { url: this.appRedirect(mobileRu, { error: message }) }
        : this.redirectOnly(frontend, {
            lark_error: message,
            return_to: returnTo,
          });

    if (!code || !state) {
      return fail('Thiếu mã xác thực Lark');
    }

    let returnTo = '/';
    let codeChallenge: string | undefined;
    try {
      const payload = this.jwtService.verify<{
        typ?: string;
        returnTo?: string;
        nh?: string;
        cc?: string;
      }>(state, this.larkVerifyOptions());
      if (payload.typ !== STATE_TYP || !sameNonce(payload.nh, nonce)) {
        return fail('Phiên đăng nhập Lark không hợp lệ. Vui lòng thử lại');
      }
      returnTo = safeReturnTo(payload.returnTo);
      codeChallenge = payload.cc;
    } catch {
      return fail('Phiên đăng nhập Lark đã hết hạn');
    }

    if (mobileRu) {
      if (!codeChallenge) {
        return fail('Phiên đăng nhập Lark không hợp lệ. Vui lòng thử lại');
      }
      try {
        const { user } = await exchangeCode(this.getOAuthConfig(), code);
        const resolved = await this.resolveLarkUser(user);
        // Không tạo phiên ở trình duyệt đăng nhập: app đổi mã này (kèm PKCE)
        // để phiên mang đúng thông tin thiết bị của app.
        return {
          url: this.appRedirect(mobileRu, {
            code: this.signMobileCode(
              resolved.userId,
              resolved.mode,
              codeChallenge,
            ),
          }),
        };
      } catch (err) {
        const message = this.callbackErrorMessage(err);
        this.logger.warn(`Lark mobile callback failed: ${message}`);
        return fail(message);
      }
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
      const message = this.callbackErrorMessage(err);
      this.logger.warn(`Lark callback failed: ${message}`);
      return fail(message, returnTo);
    }
  }

  private callbackErrorMessage(err: unknown): string {
    return err instanceof UnauthorizedException ||
      err instanceof BadRequestException
      ? err.message
      : 'Đăng nhập Lark thất bại';
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
    const resolved = await this.resolveLarkUser(profile);
    if (resolved.mode === 'setup') {
      return { mode: 'setup', token: this.signSetupToken(resolved.userId) };
    }
    const session = await this.authService.issueAuthResponse(
      resolved.userId,
      undefined,
      ctx,
    );
    this.authService.recordLogin?.(resolved.userId, 'Lark', ctx);
    return { mode: 'session', refresh: session.refresh };
  }

  /**
   * Tìm (hoặc tạo) user POS ứng với tài khoản Lark và cho biết bước tiếp theo:
   * `setup` = phải đặt mật khẩu lần đầu, `session` = được đăng nhập luôn.
   * Không tạo phiên — web và app tạo phiên ở chỗ khác nhau.
   */
  private async resolveLarkUser(
    profile: LarkUserProfile,
  ): Promise<{ mode: LarkLoginMode; userId: number }> {
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
      return { mode: 'setup', userId: user.id };
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
      return { mode: 'setup', userId: user.id };
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị vô hiệu hóa');
    }

    if (!user.password) {
      return { mode: 'setup', userId: user.id };
    }

    return { mode: 'session', userId: user.id };
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
