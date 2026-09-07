import { DebtTrackingService } from './debt-tracking.service';

describe('Debt collection attempts', () => {
  const makeService = (prisma: any) =>
    new DebtTrackingService(prisma, { create: jest.fn() } as any);

  it('rejects a duplicate or earlier date for the same role', async () => {
    const tx = {
      $queryRaw: jest.fn(),
      customer: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, code: 'KH1', name: 'A' }),
      },
      customerDebtCollectionAttempt: {
        findFirst: jest.fn().mockResolvedValue({
          attemptDate: new Date('2026-09-05T00:00:00.000Z'),
        }),
      },
    };
    const prisma = { $transaction: jest.fn((callback: any) => callback(tx)) };
    const service = makeService(prisma);

    await expect(
      service.createCollectionAttempt(
        1,
        { role: 'ACCOUNTANT', attemptDate: '2026-09-05' },
        9,
      ),
    ).rejects.toThrow('phải sau ngày 2026-09-05');
  });

  it('creates a new revision instead of overwriting the old attempt', async () => {
    const current = {
      id: 10,
      customerId: 1,
      role: 'ACCOUNTANT',
      attemptDate: new Date('2026-09-03T00:00:00.000Z'),
      recordedAt: new Date('2026-09-05T01:00:00.000Z'),
      recordedBy: { id: 9, name: 'A' },
      isActive: true,
      actionType: 'CREATE',
      supersedesId: null,
    };
    const replacement = { ...current, id: 11, attemptDate: new Date('2026-09-04') };
    const tx = {
      $queryRaw: jest.fn(),
      customerDebtCollectionAttempt: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue(replacement),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: any) => callback(tx)),
      user: { findUnique: jest.fn().mockResolvedValue({ id: 9, name: 'A' }) },
      customer: { findUnique: jest.fn().mockResolvedValue({ id: 1, code: 'KH1', name: 'A' }) },
    };
    const service = makeService(prisma);

    const result = await service.editCollectionAttempt(
      1,
      10,
      { attemptDate: '2026-09-04', reason: 'Nhập nhầm ngày' },
      9,
    );

    expect(tx.customerDebtCollectionAttempt.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { isActive: false },
    });
    expect(result.id).toBe(11);
  });
});
