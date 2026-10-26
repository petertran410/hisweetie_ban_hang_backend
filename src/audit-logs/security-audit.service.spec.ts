import { SecurityAuditService } from './security-audit.service';
import { SESSION_REVOKED, sessionEvents } from '../auth/session/session-events';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = () => {
  const auditLogs = { create: jest.fn().mockResolvedValue({ id: 1 }) };
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: 7, name: 'Chủ cửa hàng', email: 'owner@x.vn' },
        { id: 2, name: 'Admin', email: 'admin@x.vn' },
      ]),
    },
    authSession: {
      findUnique: jest.fn().mockResolvedValue({
        userId: 7,
        ip: '113.1.1.1',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      }),
    },
  };
  const service = new SecurityAuditService(auditLogs as any, prisma as any);
  return { service, auditLogs, prisma };
};

describe('SecurityAuditService', () => {
  it('writes a security-category audit row with device and IP', async () => {
    const { service, auditLogs } = setup();
    service.record('AUTH_LOGIN_FAILED', {
      userId: 7,
      ip: '1.2.3.4',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    });
    await flush();
    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: 'AUTH_LOGIN_FAILED',
        category: 'security',
        severity: 'warning',
        entityId: '7',
        ipAddress: '1.2.3.4',
        message:
          'Đăng nhập sai mật khẩu vào tài khoản Chủ cửa hàng từ Safari trên iOS, IP 1.2.3.4',
      }),
    );
  });

  it('records who granted Super Admin to whom', async () => {
    const { service, auditLogs } = setup();
    service.record('AUTH_SUPER_ADMIN_GRANT', { userId: 7, actorId: 2 });
    await flush();
    expect(auditLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        userId: 2,
        userName: 'Admin',
        message: 'Cấp vai trò Super Admin cho Chủ cửa hàng',
      }),
    );
  });

  it('a revoked-for-reuse session becomes a critical token-theft event', async () => {
    const { service, auditLogs } = setup();
    service.onModuleInit();
    sessionEvents.emit(SESSION_REVOKED, {
      userIds: [],
      sessionIds: [55],
      reason: 'reuse',
    });
    sessionEvents.emit(SESSION_REVOKED, {
      userIds: [7],
      sessionIds: [],
      reason: 'logout',
    });
    await flush();
    await flush();
    service.onModuleDestroy();
    expect(auditLogs.create).toHaveBeenCalledTimes(1);
    expect(auditLogs.create.mock.calls[0][0]).toMatchObject({
      actionCode: 'AUTH_TOKEN_REUSE',
      severity: 'critical',
      ipAddress: '113.1.1.1',
      metadata: { sessionId: 55 },
    });
  });

  it('never throws when the database is down', async () => {
    const { service, prisma } = setup();
    prisma.user.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(() =>
      service.record('AUTH_LOGIN_SUCCESS', { userId: 7 }),
    ).not.toThrow();
    await flush();
  });
});
