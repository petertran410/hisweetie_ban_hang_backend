import { LarkExpenseReviewNotificationService } from './lark-expense-review-notification.service';

describe('LarkExpenseReviewNotificationService', () => {
  const entry = {
    code: 'TCNB-CHI-HN-1',
    branchName: 'Kho Hà Nội',
    occurredAt: new Date('2026-10-14T03:00:00Z'),
    sourceType: 'FUEL',
    category: 'FUEL',
    description: 'Đổ xăng',
    expenseItem: null,
    amount: 500000,
    payerName: 'An',
    managerChecked: true,
    accountantChecked: false,
    cashIssued: false,
  };

  it('sends an interactive card to the open_id with a link to the expense', async () => {
    const create = jest.fn().mockResolvedValue({ code: 0 });
    const service = new LarkExpenseReviewNotificationService(
      { im: { message: { create } } } as any,
      { get: () => 'https://pos.example.com/' } as any,
    );
    await service.send({
      larkUserId: 'ou_abc',
      entry: {
        code: 'TCNB-CHI-HN-1',
        branchName: 'Kho Hà Nội',
        occurredAt: new Date('2026-10-14T03:00:00Z'),
        sourceType: 'FUEL',
        category: 'FUEL',
        description: 'Đổ xăng',
        expenseItem: null,
        amount: 500000,
        payerName: 'An',
        managerChecked: true,
        accountantChecked: false,
        cashIssued: false,
      },
      note: 'Thiếu hóa đơn',
      authorName: 'Bình',
    });
    const call = create.mock.calls[0][0];
    expect(call.params).toEqual({ receive_id_type: 'open_id' });
    expect(call.data).toMatchObject({
      receive_id: 'ou_abc',
      msg_type: 'interactive',
    });
    const card = JSON.stringify(JSON.parse(call.data.content));
    expect(card).toContain(
      'https://pos.example.com/tai-chinh/phieu-chi-kho?Code=TCNB-CHI-HN-1',
    );
    expect(card).toContain('Thiếu hóa đơn');
    expect(card).toContain('Xăng dầu');
    expect(card).toContain('14/10/2026');
    expect(card).toContain(
      'https://pos.example.com/tai-chinh/xe-co?Code=TCNB-CHI-HN-1&kind=FUEL',
    );
  });

  it('links packing-slip fees to the packing slip and manual expenses to nothing', () => {
    const service = new LarkExpenseReviewNotificationService(
      {} as any,
      { get: () => 'https://pos.example.com' } as any,
    );
    expect(
      service.sourceLink({
        ...entry,
        sourceType: 'PACKING_SLIP',
        packingSlipCode: 'BD-30',
      }),
    ).toEqual({
      label: 'Sửa ở Báo đơn',
      url: 'https://pos.example.com/don-hang/bao-don?Code=BD-30',
    });
    expect(
      service.sourceLink({ ...entry, sourceType: 'MANUAL_EXPENSE' }),
    ).toBeNull();
    expect(
      service.sourceLink({ ...entry, sourceType: 'LARK_IMPORT' }),
    ).toBeNull();
  });

  it('throws when Lark rejects the message', async () => {
    const service = new LarkExpenseReviewNotificationService(
      {
        im: {
          message: {
            create: jest.fn().mockResolvedValue({ code: 99, msg: 'denied' }),
          },
        },
      } as any,
      { get: () => undefined } as any,
    );
    await expect(
      service.send({
        larkUserId: 'ou_abc',
        entry,
        note: '',
        authorName: '',
      }),
    ).rejects.toThrow('Lark 99: denied');
  });
});
