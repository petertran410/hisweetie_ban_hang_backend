import { NotFoundException } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('Admin: devices of a user', () => {
  it.each(['listSessions', 'revokeSession', 'revokeAllSessions'] as const)(
    '%s requires users:update',
    (method) => {
      const perms = Reflect.getMetadata(
        PERMISSIONS_KEY,
        UsersController.prototype[method],
      );
      expect(perms).toEqual(['users:update']);
    },
  );

  const build = (sessions: any[]) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 3,
          name: 'NV A',
          email: 'a@x.vn',
        }),
      },
    };
    const audit = { create: jest.fn() };
    const sessionService = {
      listActiveSessions: jest.fn().mockResolvedValue(sessions),
      revokeSession: jest.fn().mockResolvedValue(true),
      revokeOtherSessions: jest.fn().mockResolvedValue(sessions.length),
    };
    const service = new UsersService(
      prisma as any,
      audit as any,
      { invalidateUser: jest.fn() } as any,
      sessionService as any,
    );
    return { service, audit, sessionService };
  };

  const chromeWin = {
    id: 9,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    ip: '1.1.1.1',
    createdAt: new Date(),
    lastUsedAt: new Date(),
  };

  it('lists devices with readable browser/OS', async () => {
    const { service } = build([chromeWin]);
    const list = await service.listUserSessions(3);
    expect(list[0]).toMatchObject({
      id: 9,
      browser: 'Chrome',
      os: 'Windows',
      deviceType: 'desktop',
    });
  });

  it('revoking a device writes an audit log', async () => {
    const { service, audit, sessionService } = build([chromeWin]);
    await service.revokeUserSession(3, 9, 1);
    expect(sessionService.revokeSession).toHaveBeenCalledWith(3, 9);
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: 'USER_SESSION_REVOKE',
        entityId: '3',
        userId: 1,
      }),
    );
  });

  it('rejects a device id that does not belong to that user', async () => {
    const { service, sessionService } = build([chromeWin]);
    await expect(service.revokeUserSession(3, 777, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(sessionService.revokeSession).not.toHaveBeenCalled();
  });
});
