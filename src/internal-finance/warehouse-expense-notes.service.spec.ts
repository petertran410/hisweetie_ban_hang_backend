import { WarehouseExpenseNotesService } from './warehouse-expense-notes.service';

describe('WarehouseExpenseNotesService', () => {
  const entry = {
    id: 9,
    code: 'TCNB-CHI-HN-20261014-000001',
    branchId: 6,
    direction: 'EXPENSE',
    occurredAt: new Date('2026-10-14T03:00:00Z'),
    sourceType: 'MANUAL_EXPENSE',
    category: 'OTHER_EXPENSE',
    description: 'Mua băng keo',
    expenseItem: 'Vật tư',
    amount: 120000,
    managerReviewedAt: new Date(),
    accountantReviewedAt: null,
    cashIssued: false,
    branch: { name: 'Kho Hà Nội' },
    payer: { name: 'An' },
  };

  const setup = (canTag: number[] = [11, 12]) => {
    const mentionUpdate = jest.fn();
    const created = {
      id: 1,
      creator: { id: 7, name: 'Bình' },
      mentions: [
        {
          id: 100,
          userId: 11,
          user: { id: 11, name: 'C', larkUserId: 'ou_c' },
        },
        { id: 101, userId: 12, user: { id: 12, name: 'D', larkUserId: null } },
      ],
    };
    const prisma = {
      internalFinanceEntry: {
        findUnique: jest.fn().mockResolvedValue(entry),
      },
      internalFinanceEntryNote: {
        create: jest.fn().mockResolvedValue(created),
        findUnique: jest.fn().mockResolvedValue({ id: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      internalFinanceEntryNoteMention: { update: mentionUpdate },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 11, name: 'C' },
          { id: 12, name: 'D' },
          { id: 13, name: 'E' },
        ]),
      },
    };
    // Người thao tác (id 7) có quyền ghi chú; người được tag xem được kho 6.
    const access = {
      can: jest.fn(
        async (actor: any, _branchId: number, permission: string) => {
          const id = typeof actor === 'number' ? actor : actor.id;
          if (id === 7)
            return permission === 'warehouse_expense:request_review';
          return canTag.includes(id) && permission === 'warehouse_expense:view';
        },
      ),
    };
    const lark = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new WarehouseExpenseNotesService(
      prisma as any,
      access as any,
      lark as any,
    );
    return { service, prisma, access, lark, mentionUpdate };
  };
  const user = { id: 7, roles: [], branchIds: [6] };

  it('saves the note and sends a Lark card to each tagged user', async () => {
    const { service, prisma, lark, mentionUpdate } = setup();
    const result = await service.create(
      9,
      { content: '  Kiểm lại hóa đơn ', mentionUserIds: [11, 12, 11] },
      user,
    );
    expect(
      prisma.internalFinanceEntryNote.create.mock.calls[0][0].data,
    ).toMatchObject({
      entryId: 9,
      content: 'Kiểm lại hóa đơn',
      createdBy: 7,
      mentions: { create: [{ userId: 11 }, { userId: 12 }] },
    });
    expect(lark.send).toHaveBeenCalledTimes(1);
    expect(lark.send.mock.calls[0][0]).toMatchObject({
      larkUserId: 'ou_c',
      note: 'Kiểm lại hóa đơn',
      authorName: 'Bình',
      entry: { code: entry.code, amount: 120000, managerChecked: true },
    });
    expect(mentionUpdate).toHaveBeenCalledWith({
      where: { id: 100 },
      data: expect.objectContaining({ larkStatus: 'SENT' }),
    });
    expect(mentionUpdate).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({ larkStatus: 'NO_LARK' }),
    });
    expect(result).toMatchObject({ sent: 1, failed: 1 });
  });

  it('keeps the note when Lark fails', async () => {
    const { service, lark, mentionUpdate } = setup();
    lark.send.mockRejectedValue(new Error('Lark 230002: bot not in chat'));
    const result = await service.create(
      9,
      { content: 'Xem lại', mentionUserIds: [11, 12] },
      user,
    );
    expect(mentionUpdate).toHaveBeenCalledWith({
      where: { id: 100 },
      data: expect.objectContaining({ larkStatus: 'ERROR' }),
    });
    expect(result).toMatchObject({ sent: 0, failed: 2 });
  });

  it('refuses to tag users who cannot view this warehouse', async () => {
    const { service, prisma } = setup([11]);
    await expect(
      service.create(9, { content: 'Xem lại', mentionUserIds: [12] }, user),
    ).rejects.toThrow('không xem được phiếu chi');
    expect(prisma.internalFinanceEntryNote.create).not.toHaveBeenCalled();
  });

  it('requires the request_review permission to add notes', async () => {
    const { service, access } = setup();
    access.can.mockResolvedValue(false);
    await expect(
      service.create(9, { content: 'Xem lại' }, user),
    ).rejects.toThrow('Không có quyền ghi chú');
  });

  it('lists candidates that are active, linked to Lark and can view', async () => {
    const { service, prisma } = setup([11]);
    expect(await service.mentionCandidates(9, user)).toEqual([
      { id: 11, name: 'C' },
    ]);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
      larkUserId: { not: null },
    });
  });
});
