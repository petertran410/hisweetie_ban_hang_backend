import { BadRequestException } from '@nestjs/common';
import { MessageIntelService } from './message-intel.service';
import { vnDay } from './message-intel.config';

const actor = { id: 1, name: 'Admin' };

function make(version: object | null = { id: 3, name: 'v1', status: 'draft' }) {
  const prisma = {
    smaxIntelVersion: {
      findUnique: jest.fn().mockResolvedValue(version),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockReturnValue('retire'),
      update: jest.fn().mockReturnValue('activate'),
    },
    smaxMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 9_999n } }),
    },
    smaxIntelRuntime: {
      upsert: jest.fn().mockImplementation(() =>
        Promise.resolve({
          dailyTokenBudget: 1000,
          tokensToday: 400,
          budgetDay: vnDay(),
        }),
      ),
      update: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn(),
  };
  const audit = { create: jest.fn() };
  return {
    prisma,
    audit,
    svc: new MessageIntelService(prisma as any, audit as any),
  };
}

describe('MessageIntelService', () => {
  it('kích hoạt phiên bản nháp: phiên bản cũ retired, quét tin mới bắt đầu từ tin lớn nhất hiện có, ghi audit', async () => {
    const { prisma, audit, svc } = make();
    await svc.activate(3, actor);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.smaxIntelVersion.updateMany).toHaveBeenCalledWith({
      where: { status: 'active' },
      data: { status: 'retired' },
    });
    const upsert = (
      prisma.smaxIntelRuntime.upsert.mock.calls as unknown[][]
    )[0][0] as {
      update: { discoveryCursor: bigint };
    };
    expect(upsert.update.discoveryCursor).toBe(9_999n);
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCode: 'MESSAGE_INTEL_VERSION_ACTIVATE',
        category: 'message_intel',
      }),
    );
  });

  it('phiên bản đã dùng (active / retired) không kích hoạt lại được', async () => {
    const { svc } = make({ id: 3, name: 'v1', status: 'retired' });
    await expect(svc.activate(3, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('ngân sách token: cùng ngày trừ phần đã dùng; sang ngày mới đủ lại', async () => {
    const { prisma, svc } = make();
    expect(await svc.budgetLeft()).toBe(600);
    prisma.smaxIntelRuntime.upsert.mockResolvedValueOnce({
      dailyTokenBudget: 1000,
      tokensToday: 999,
      budgetDay: '2000-01-01',
    });
    expect(await svc.budgetLeft()).toBe(1000);
  });

  it('backfill cần phiên bản đang chạy và khoảng ngày hợp lệ', async () => {
    const { svc } = make();
    await expect(
      svc.startBackfill(
        { from: new Date('2026-11-01'), to: new Date('2026-11-02') },
        actor,
      ),
    ).rejects.toThrow('Chưa có phiên bản');
  });
});
