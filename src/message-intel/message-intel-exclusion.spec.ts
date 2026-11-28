import { NotFoundException } from '@nestjs/common';
import { MessageIntelExclusionService } from './message-intel-exclusion.service';

const actor = { id: 1, name: 'Admin' };

function make(opts: { existing?: object | null; group?: object[] } = {}) {
  const prisma = {
    smaxIntelExclusion: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      findMany: jest.fn().mockResolvedValue(opts.group ?? []),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    smaxThread: {
      findMany: jest.fn().mockResolvedValue([
        { pagePid: 'zlwA', tid: 't1', name: 'Báo đơn' },
        { pagePid: 'zlwB', tid: 't9', name: 'Báo đơn' },
      ]),
    },
    smaxSyncChannel: {
      findMany: jest.fn().mockResolvedValue([
        { pagePid: 'zlwA', name: 'Ms Mai Phương' },
        { pagePid: 'zlwB', name: 'Mr Nam' },
      ]),
    },
    smaxMessageIntel: {
      updateMany: jest.fn().mockResolvedValue({ count: 5 }),
      findMany: jest.fn().mockResolvedValue([
        { id: 11n, messageId: 101n },
        { id: 12n, messageId: 102n },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    smaxMessage: {
      findMany: jest.fn().mockResolvedValue([{ id: 101n }, { id: 102n }]),
    },
    // Cùng nhóm ở kênh B (chung msg_pid)
    $queryRaw: jest.fn().mockResolvedValue([
      { page_pid: 'zlwA', tid: 't1' },
      { page_pid: 'zlwB', tid: 't9' },
    ]),
  };
  const intel = {
    ourPagePids: jest.fn().mockResolvedValue(new Set(['zlwA', 'zlwB'])),
    activeVersion: jest.fn().mockResolvedValue({ id: 3 }),
  };
  const query = { excludedKeys: jest.fn().mockResolvedValue(new Set()) };
  const discovery = { createJobs: jest.fn().mockResolvedValue(2) };
  const audit = { create: jest.fn() };
  return {
    prisma,
    discovery,
    audit,
    svc: new MessageIntelExclusionService(
      prisma as any,
      intel as any,
      query as any,
      discovery as any,
      audit as any,
    ),
  };
}

describe('MessageIntelExclusionService', () => {
  it('loại trừ 1 kênh = cả nhóm: lưu mọi hội thoại cùng msg_pid dưới 1 group_key, tin chờ gửi AI chuyển bỏ qua', async () => {
    const { prisma, audit, svc } = make();
    const r = await svc.add({ pagePid: 'zlwA', tid: 't1' }, actor);
    expect(r).toEqual({ groupKey: 'zlwA:t1', threads: 2, skipped: 5 });
    const data = (
      prisma.smaxIntelExclusion.createMany.mock.calls[0] as [{ data: object[] }]
    )[0].data;
    expect(data).toEqual([
      expect.objectContaining({
        groupKey: 'zlwA:t1',
        pagePid: 'zlwA',
        tid: 't1',
        name: 'Báo đơn',
        createdBy: 1,
      }),
      expect.objectContaining({
        groupKey: 'zlwA:t1',
        pagePid: 'zlwB',
        tid: 't9',
      }),
    ]);
    expect(
      (prisma.smaxMessageIntel.updateMany.mock.calls[0] as unknown[])[0],
    ).toMatchObject({
      where: {
        status: { in: ['pending', 'retry'] },
        OR: [
          { pagePid: 'zlwA', tid: 't1' },
          { pagePid: 'zlwB', tid: 't9' },
        ],
      },
      data: { status: 'skipped', skipReason: 'excluded' },
    });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'MESSAGE_INTEL_EXCLUDE' }),
    );
  });

  it('đã loại trừ → không làm gì thêm', async () => {
    const { prisma, svc } = make({ existing: { groupKey: 'zlwB:t9' } });
    expect(await svc.add({ pagePid: 'zlwA', tid: 't1' }, actor)).toEqual({
      groupKey: 'zlwB:t9',
      threads: 0,
      skipped: 0,
    });
    expect(prisma.smaxIntelExclusion.createMany).not.toHaveBeenCalled();
  });

  it('bỏ loại trừ từ khung chat (theo 1 kênh của nhóm): xoá cả nhóm, tin đã bỏ qua vì loại trừ được xét lại', async () => {
    const group = [
      { groupKey: 'zlwA:t1', pagePid: 'zlwA', tid: 't1', name: 'Báo đơn' },
      { groupKey: 'zlwA:t1', pagePid: 'zlwB', tid: 't9', name: 'Báo đơn' },
    ];
    const { prisma, discovery, svc } = make({
      existing: { groupKey: 'zlwA:t1' },
      group,
    });
    expect(await svc.remove({ pagePid: 'zlwB', tid: 't9' }, actor)).toEqual({
      groupKey: 'zlwA:t1',
      requeued: 2,
    });
    expect(prisma.smaxIntelExclusion.deleteMany).toHaveBeenCalledWith({
      where: { groupKey: 'zlwA:t1' },
    });
    expect(
      (prisma.smaxMessageIntel.findMany.mock.calls[0] as unknown[])[0],
    ).toMatchObject({
      where: { versionId: 3, skipReason: 'excluded' },
    });
    expect(prisma.smaxMessageIntel.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11n, 12n] } },
    });
    expect(discovery.createJobs).toHaveBeenCalledWith(
      [{ id: 101n }, { id: 102n }],
      3,
    );
  });

  it('bỏ loại trừ hội thoại không có trong danh sách → 404', async () => {
    const { svc } = make();
    await expect(
      svc.remove({ groupKey: 'zlwA:none' }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('danh sách gộp theo nhóm: hội thoại được chọn đứng đầu, kèm tên kênh', async () => {
    const at = new Date('2026-11-28T03:00:00Z');
    const { svc } = make({
      group: [
        {
          groupKey: 'zlwA:t1',
          pagePid: 'zlwB',
          tid: 't9',
          name: 'Báo đơn',
          createdByName: 'Admin',
          createdAt: at,
        },
        {
          groupKey: 'zlwA:t1',
          pagePid: 'zlwA',
          tid: 't1',
          name: 'Báo đơn',
          createdByName: 'Admin',
          createdAt: at,
        },
      ],
    });
    const [g] = await svc.list();
    expect(g).toMatchObject({ groupKey: 'zlwA:t1', name: 'Báo đơn' });
    expect(g.threads.map((t) => t.channel)).toEqual([
      'Ms Mai Phương',
      'Mr Nam',
    ]);
  });
});
