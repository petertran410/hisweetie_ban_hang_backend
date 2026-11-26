import { AuditLogsService } from './audit-logs.service';
import type { PrismaService } from '../prisma/prisma.service';

type DeleteManyArgs = {
  where: {
    createdAt: { lt: Date };
    OR: Array<{ category: null | { not: string } }>;
  };
};

describe('AuditLogsService.deleteOldLogs', () => {
  it('never deletes internal finance history (category internal_finance)', async () => {
    const deleteMany = jest.fn((args: DeleteManyArgs) =>
      Promise.resolve({ count: args.where.OR.length }),
    );
    const prisma = { auditLog: { deleteMany } } as unknown as PrismaService;
    const service = new AuditLogsService(prisma);

    const before = new Date();
    await service.deleteOldLogs(6);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const { where } = deleteMany.mock.calls[0][0];
    // Dòng category null vẫn được dọn; chỉ giữ lại lịch sử tài chính nội bộ.
    expect(where.OR).toEqual([
      { category: null },
      { category: { not: 'internal_finance' } },
    ]);
    const cutoff = new Date(before);
    cutoff.setMonth(cutoff.getMonth() - 6);
    expect(
      Math.abs(where.createdAt.lt.getTime() - cutoff.getTime()),
    ).toBeLessThan(5000);
  });
});
