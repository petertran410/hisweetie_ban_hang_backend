import { FinanceCutoverService } from './finance-cutover.service';

describe('FinanceCutoverService', () => {
  const make = (financeCutoverAt: Date | null = null) => {
    const row: any = { id: 1, financeCutoverAt };
    const prisma = {
      settings: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      },
    };
    return { service: new FinanceCutoverService(prisma as any), row };
  };

  it('lets only a Super Admin lock, then blocks further syncs until reopened', async () => {
    const { service } = make();
    await expect(service.assertOpen()).resolves.toBeUndefined();
    await expect(service.set(true, { roles: ['Kế toán'] })).rejects.toThrow(
      'Super Admin',
    );
    const locked = await service.set(true, { roles: ['Super Admin'] });
    expect(locked.locked).toBe(true);
    expect(locked.cutoverAt).toBeInstanceOf(Date);
    await expect(service.assertOpen()).rejects.toThrow('Đã chốt chuyển đổi');
    expect((await service.set(false, { roles: ['Super Admin'] })).locked).toBe(
      false,
    );
    await expect(service.assertOpen()).resolves.toBeUndefined();
  });
});
