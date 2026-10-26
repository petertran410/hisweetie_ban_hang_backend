import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { LoginAttemptsService } from './login-attempts.service';
import { SecurityAuditService } from '../audit-logs/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';
import { isRetiredPermissionName } from '../permissions/permission-policy';
import * as bcrypt from 'bcrypt';
import {
  IssuedRefresh,
  SessionContext,
  SessionService,
} from './session/session.service';
import { sessionConfig, ttlToSeconds } from './session/session.config';
import { describeUserAgent } from './session/user-agent.util';
import { ACCESS_TOKEN_AUDIENCE, JWT_ISSUER } from './jwt-secret.util';

export const INVALID_LOGIN_MESSAGE = 'Email hoặc mật khẩu không đúng';

/** Hash giả để so sánh khi không có user — thời gian phản hồi như khi có user. */
let dummyHash: Promise<string> | undefined;
const dummyPasswordHash = () =>
  (dummyHash ??= bcrypt.hash(randomBytes(16).toString('hex'), 10));

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private permissionCache: PermissionCacheService,
    private sessionService: SessionService,
    @Optional() private loginAttempts?: LoginAttemptsService,
    @Optional() private securityAudit?: SecurityAuditService,
  ) {}

  async login(
    email: string,
    password: string,
    branchId?: number,
    ctx?: SessionContext,
  ) {
    this.loginAttempts?.assertNotLocked(email, ctx?.ip);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, password: true, isActive: true },
    });

    // Luôn chạy bcrypt (kể cả khi email không tồn tại / tài khoản chỉ dùng
    // Lark) và trả cùng 1 thông báo → không dò được email nào có trong hệ thống.
    const isPasswordValid = await bcrypt.compare(
      password,
      user?.password || (await dummyPasswordHash()),
    );
    if (!user || !user.password || !isPasswordValid) {
      const locked = this.loginAttempts?.recordFailure(email, ctx?.ip);
      if (user) {
        const event = {
          userId: user.id,
          ip: ctx?.ip,
          userAgent: ctx?.userAgent,
        };
        this.securityAudit?.record('AUTH_LOGIN_FAILED', event);
        if (locked?.lockedNow) {
          this.securityAudit?.record('AUTH_LOGIN_LOCKED', event);
        }
      }
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }
    // Chỉ báo "bị khoá" khi đã nhập ĐÚNG mật khẩu.
    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị vô hiệu hóa');
    }

    this.loginAttempts?.recordSuccess(email, ctx?.ip);
    const response = await this.issueAuthResponse(user.id, branchId, ctx);
    this.recordLogin(user.id, 'mật khẩu', ctx);
    return response;
  }

  /** Ghi nhật ký bảo mật cho 1 lần đăng nhập thành công. */
  recordLogin(userId: number, method: string, ctx?: SessionContext) {
    this.securityAudit?.record('AUTH_LOGIN_SUCCESS', {
      userId,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      params: { method },
    });
  }

  /**
   * Access token JWT ngắn hạn. JWT chỉ được KÝ, không mã hóa — ai cầm token
   * cũng đọc được payload, nên chỉ chứa id, permissionVersion, id phiên.
   */
  signAccessToken(userId: number, permissionVersion: number, sid: number) {
    const ttl = sessionConfig.accessTokenTtl;
    return {
      accessToken: this.jwtService.sign(
        { sub: userId, pv: permissionVersion, typ: 'access', sid },
        {
          expiresIn: ttl,
          issuer: JWT_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
        },
      ),
      expiresIn: ttlToSeconds(ttl),
    };
  }

  /** Danh sách thiết bị đang đăng nhập của user, đánh dấu thiết bị hiện tại. */
  async listDevices(userId: number, currentSessionId?: number) {
    const sessions = await this.sessionService.listActiveSessions(userId);
    return sessions.map((session) => ({
      id: session.id,
      ...describeUserAgent(session.userAgent),
      ip: session.ip,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      current: session.id === currentSessionId,
    }));
  }

  /** Đọc payload (đã được JwtAuthGuard verify trước đó). */
  decodeToken(token: string): { sid?: number } | null {
    return this.jwtService.decode<{ sid?: number } | null>(token);
  }

  /** Đổi refresh token (cookie) lấy access token mới + refresh token mới. */
  async refresh(raw: string, ctx: SessionContext) {
    const rotated = await this.sessionService.rotate(raw, ctx);
    return {
      ...this.signAccessToken(
        rotated.userId,
        rotated.permissionVersion,
        rotated.sessionId,
      ),
      refresh: rotated.refresh,
    };
  }

  async issueAuthResponse(
    userId: number,
    branchId?: number,
    ctx?: SessionContext,
  ): Promise<{
    accessToken: string;
    expiresIn: number;
    refresh: IssuedRefresh;
    user: Record<string, unknown>;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is inactive');

    const roles = user.userRoles.map((ur) => ur.role.name);

    const effectiveBranchId = branchId ?? user.branchId ?? undefined;

    let permissions: string[];
    if (effectiveBranchId) {
      permissions = await this.getPermissionsForBranch(
        user.id,
        effectiveBranchId,
      );
    } else {
      const rolePermissions = user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      );
      const grantPermissions = user.userPermissions
        .filter((up) => up.type === 'grant')
        .map((up) => up.permission.name);
      const denyPermissions = new Set(
        user.userPermissions
          .filter((up) => up.type === 'deny')
          .map((up) => up.permission.name),
      );
      permissions = [
        ...new Set([...rolePermissions, ...grantPermissions]),
      ].filter((p) => !denyPermissions.has(p) && !isRetiredPermissionName(p));
    }

    const userBranches = await this.prisma.userBranch.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    });
    const branchIds = userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    const refresh = await this.sessionService.createSession(
      user.id,
      user.permissionVersion,
      ctx,
    );
    const { accessToken, expiresIn } = this.signAccessToken(
      user.id,
      user.permissionVersion,
      refresh.sessionId,
    );

    return {
      accessToken,
      expiresIn,
      refresh,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
        roles,
        permissions,
        branchId: user.branchId,
        branchIds,
        supplierId: user.supplierId ?? null,
        canViewOtherStaffData: user.canViewOtherStaffData,
        canViewOnlyOwnPackings: user.canViewOnlyOwnPackings,
        canViewOnlyOwnLoadingInvoices: user.canViewOnlyOwnLoadingInvoices,
      },
    };
  }

  async validateUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return null;
    }

    return user;
  }

  async getProfile(userId: number, branchId?: number) {
    // FE gọi profile mỗi lần load trang/đổi chi nhánh (RouteGuard) — mỗi lần
    // ~25 câu SQL. Cache 60s, xóa qua invalidateUser/invalidateAll khi quyền,
    // trạng thái hoặc thông tin user thay đổi.
    const cached = this.permissionCache.getProfile(userId, branchId);
    if (cached) return cached;

    const profile = await this.loadProfile(userId, branchId);
    this.permissionCache.setProfile(userId, branchId, profile);
    return profile;
  }

  private async loadProfile(userId: number, branchId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: { select: { id: true, name: true } },
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
        userBranches: {
          include: { branch: { select: { id: true, name: true } } },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    let permissions: string[];

    if (branchId) {
      permissions = await this.getPermissionsForBranch(userId, branchId);
    } else {
      const rolePermissions = user.userRoles.flatMap((ur) =>
        ur.role.rolePermissions.map((rp) => rp.permission.name),
      );
      const grantPermissions = user.userPermissions
        .filter((up) => up.type === 'grant')
        .map((up) => up.permission.name);
      const denyPermissions = new Set(
        user.userPermissions
          .filter((up) => up.type === 'deny')
          .map((up) => up.permission.name),
      );
      permissions = [
        ...new Set([...rolePermissions, ...grantPermissions]),
      ].filter((p) => !denyPermissions.has(p) && !isRetiredPermissionName(p));
    }

    const branchIds = user.userBranches.map((ub) => ub.branchId);
    if (user.branchId && !branchIds.includes(user.branchId)) {
      branchIds.push(user.branchId);
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar,
      roles,
      permissions,
      branchId: user.branchId,
      branchIds,
      supplierId: user.supplierId ?? null,
      canViewOtherStaffData: user.canViewOtherStaffData,
      canViewOnlyOwnPackings: user.canViewOnlyOwnPackings,
      canViewOnlyOwnLoadingInvoices: user.canViewOnlyOwnLoadingInvoices,
      permissionVersion: user.permissionVersion,
    };
  }

  async updateProfile(
    userId: number,
    data: { name?: string; phone?: string; avatar?: string },
  ) {
    // Chỉ lấy đúng 3 trường — KHÔNG đưa nguyên body vào Prisma (body có thể
    // chứa `userRoles`, `isActive`... → tự nâng quyền).
    const { name, phone, avatar } = data ?? {};
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { name, phone, avatar },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
      },
    });
    this.permissionCache.invalidateUser(userId);
    return updated;
  }

  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.password) {
      throw new UnauthorizedException(
        'Cannot change password for Google account',
      );
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Đổi mật khẩu → mọi thiết bị (kể cả thiết bị hiện tại) đăng nhập lại.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        permissionVersion: { increment: 1 },
      },
    });
    this.permissionCache.invalidateUser(userId);
    await this.sessionService.forceReLogin([userId], 'password');
    this.securityAudit?.record('AUTH_PASSWORD_CHANGE', {
      userId,
      params: { method: 'tự đổi' },
    });

    return { message: 'Password changed successfully' };
  }

  async getPermissionsForBranch(
    userId: number,
    branchId?: number,
  ): Promise<string[]> {
    const [user, branchOverrides] = await Promise.all([
      this.loadUserForBranchPermissions(userId, branchId),
      branchId
        ? this.prisma.userBranchPermission.findMany({
            where: { userId, branchId },
            include: { permission: true },
          })
        : Promise.resolve([]),
    ]);

    if (!user) return [];

    // `branchId` đến từ client (header X-Branch-Id / body / query). User không
    // gắn gì với chi nhánh đó → KHÔNG lấy quyền riêng của chi nhánh ấy (chống
    // chọn chi nhánh có role-branch-permission rộng hơn), chỉ dùng quyền chung.
    const userBranchRoles = (user as any).userBranchRoles || [];
    const isMember =
      !!branchId &&
      (user.branchId === branchId ||
        ((user as any).userBranches || []).length > 0 ||
        userBranchRoles.length > 0 ||
        branchOverrides.length > 0);
    const scopedBranchId = isMember ? branchId : undefined;

    const basePermKeys = new Set<string>();

    // Ưu tiên branch-specific role, fallback về global roles
    const rolesSource =
      scopedBranchId && userBranchRoles.length > 0
        ? userBranchRoles.map((ubr: any) => ubr.role)
        : user.userRoles.map((ur) => ur.role);

    for (const role of rolesSource) {
      const branchPerms = scopedBranchId
        ? role.roleBranchPermissions || []
        : [];
      const source =
        branchPerms.length > 0 ? branchPerms : role.rolePermissions;
      for (const rp of source) {
        basePermKeys.add(`${rp.permission.resource}:${rp.permission.action}`);
      }
    }

    const grantKeys = new Set<string>();
    const denyKeys = new Set<string>();
    for (const up of user.userPermissions) {
      const key = `${up.permission.resource}:${up.permission.action}`;
      if (up.type === 'grant') grantKeys.add(key);
      else if (up.type === 'deny') denyKeys.add(key);
    }

    const permissions = new Set([...basePermKeys, ...grantKeys]);
    for (const dk of denyKeys) permissions.delete(dk);

    if (scopedBranchId) {
      for (const bp of branchOverrides) {
        const key = `${bp.permission.resource}:${bp.permission.action}`;
        if (bp.granted) permissions.add(key);
        else permissions.delete(key);
      }
    }

    return Array.from(permissions).filter(
      (permission) => !isRetiredPermissionName(permission),
    );
  }

  private loadUserForBranchPermissions(userId: number, branchId?: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        ...(branchId
          ? {
              userBranches: {
                where: { branchId },
                select: { branchId: true },
              },
            }
          : {}),
        userBranchRoles: {
          ...(branchId ? { where: { branchId } } : {}),
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
                ...(branchId
                  ? {
                      roleBranchPermissions: {
                        where: { branchId },
                        include: { permission: true },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
                ...(branchId
                  ? {
                      roleBranchPermissions: {
                        where: { branchId },
                        include: { permission: true },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        userPermissions: { include: { permission: true } },
      },
    });
  }
}
