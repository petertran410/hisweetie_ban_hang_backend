import {
  NewProductPriceNotifyService,
  nppTicketPath,
  resolveRecipients,
} from './new-product-price-notify.service';

describe('nppTicketPath', () => {
  it('link xem phiếu: chỉ có Code', () => {
    expect(nppTicketPath('SPM000001')).toBe(
      '/san-pham/bang-gia-san-pham-moi?Code=SPM000001',
    );
  });

  it('tin cần xử lý: thêm open=1 để mở sẵn modal', () => {
    expect(nppTicketPath('SPM000001', true)).toBe(
      '/san-pham/bang-gia-san-pham-moi?Code=SPM000001&open=1',
    );
  });
});
import { buildTicketCard } from './new-product-price-lark-cards';

describe('resolveRecipients', () => {
  it('bỏ trùng và bỏ người đang thao tác', () => {
    expect(resolveRecipients([20, 21, 20, 10], 10)).toEqual([20, 21]);
  });

  it('không có người thao tác (nhắc việc) → gửi cả nhóm', () => {
    expect(resolveRecipients([20, 21], null)).toEqual([20, 21]);
  });
});

describe('card phiếu', () => {
  it('không còn ghi chú gửi thử ở đầu tin', () => {
    const built = buildTicketCard(
      'ENTER_CEO',
      { code: 'SPM000001', productName: 'Siro', createdAt: new Date() },
      { link: 'https://pos/x', greetingNames: ['Chị A'] },
    );
    const content = (built.card as any).elements[0].text.content as string;
    expect(content.startsWith('Gửi Chị A')).toBe(true);
    expect(built.body.startsWith('SPM000001')).toBe(true);
  });
});

describe('NewProductPriceNotifyService — chủ đề trong nhóm Lark', () => {
  const ticket = {
    id: 7,
    code: 'SPM000007',
    productName: 'Siro',
    createdAt: new Date(),
    createdById: 5,
    createdByName: 'Người đề xuất',
    costApproverId: null,
  };

  function setup(opts: { chatId?: string | null; rootFails?: boolean } = {}) {
    const events: any[] = [];
    const prisma = {
      newProductPriceTicket: {
        findUnique: jest.fn().mockResolvedValue(ticket),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, name: 'Admin', larkUserId: 'ou_admin' },
          { id: 2, name: 'Thu Mua B', larkUserId: null },
        ]),
      },
      newProductPriceEvent: {
        create: jest.fn(({ data }) => {
          events.push({ id: events.length + 1, ...data });
          return Promise.resolve({});
        }),
        findMany: jest.fn(({ where }) =>
          Promise.resolve(
            events.filter((e) => e.data?.group?.chatId === where.data.equals),
          ),
        ),
      },
    };
    const lark = {
      im: {
        message: {
          create: jest.fn(({ params }) =>
            Promise.resolve(
              params.receive_id_type === 'chat_id' && opts.rootFails
                ? { code: 230002, msg: 'bot not in chat' }
                : {
                    code: 0,
                    data: { message_id: `om_${params.receive_id_type}` },
                  },
            ),
          ),
          reply: jest.fn(() =>
            Promise.resolve({ code: 0, data: { message_id: 'om_reply' } }),
          ),
        },
      },
    };
    const cfg = {
      get: jest.fn().mockResolvedValue({
        approvers: { PURCHASING: [1, 2], ACCOUNTING: [1] },
        larkChatId: opts.chatId === undefined ? 'oc_group' : opts.chatId,
      }),
    };
    const service = new NewProductPriceNotifyService(
      prisma as any,
      { get: () => 'https://pos' } as any,
      { createForUsers: jest.fn().mockResolvedValue(0) } as any,
      cfg as any,
      lark as any,
    );
    return { service, lark, events };
  }

  it('lần đầu mở chủ đề rồi trả lời trong chủ đề; bước sau chỉ trả lời vào chủ đề cũ', async () => {
    const { service, lark, events } = setup();
    await service.notify('ENTER_PURCHASING', 7, { actorId: 5 });
    await service.notify('ENTER_ACCOUNTING', 7, { actorId: 5 });

    const groupCreates = lark.im.message.create.mock.calls.filter(
      ([p]: any) => p.params.receive_id_type === 'chat_id',
    );
    expect(groupCreates).toHaveLength(1);
    expect(groupCreates[0][0].data.receive_id).toBe('oc_group');
    expect(lark.im.message.reply).toHaveBeenCalledTimes(2);
    for (const [p] of lark.im.message.reply.mock.calls as any[]) {
      expect(p.path.message_id).toBe('om_chat_id');
      expect(p.data.reply_in_thread).toBe(true);
      expect(p.data.msg_type).toBe('post');
    }
    const first = JSON.parse(
      (lark.im.message.reply.mock.calls[0] as any)[0].data.content,
    ).zh_cn;
    expect(first.title).toBe('Thông báo đề xuất sản phẩm mới');
    expect(first.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_admin', user_name: 'Admin' },
      { tag: 'text', text: ' ' },
      { tag: 'text', text: 'Thu Mua B', style: ['bold'] },
    ]);
    expect(events[0].data.group).toMatchObject({
      chatId: 'oc_group',
      rootMessageId: 'om_chat_id',
      created: true,
      mentioned: ['Admin', 'Thu Mua B'],
      status: 'SENT',
    });
    expect(events[1].data.group.created).toBe(false);
  });

  it('không mở được chủ đề → ghi lỗi, không trả lời; tin riêng vẫn gửi', async () => {
    const { service, lark, events } = setup({ rootFails: true });
    await service.notify('ENTER_PURCHASING', 7, { actorId: 5 });
    expect(lark.im.message.reply).not.toHaveBeenCalled();
    expect(events[0].data.group).toMatchObject({
      status: 'ERROR',
      error: 'Lark 230002: bot not in chat',
    });
    expect(events[0].data.recipients[0]).toMatchObject({
      name: 'Admin',
      status: 'SENT',
    });
  });

  it('chưa cấu hình nhóm → chỉ gửi tin riêng', async () => {
    const { service, lark, events } = setup({ chatId: null });
    await service.notify('ENTER_PURCHASING', 7, { actorId: 5 });
    expect(lark.im.message.reply).not.toHaveBeenCalled();
    expect(events[0].data.group).toBeUndefined();
  });

  it('chủ đề tag cả người vừa thao tác (bước mới cũng là việc của họ), tin riêng thì không', async () => {
    const { service, lark, events } = setup();
    await service.notify('ENTER_PURCHASING', 7, { actorId: 1 });
    const post = JSON.parse(
      (lark.im.message.reply.mock.calls[0] as any)[0].data.content,
    ).zh_cn;
    expect(post.content[0][0]).toEqual({
      tag: 'at',
      user_id: 'ou_admin',
      user_name: 'Admin',
    });
    expect(post.content[1]).toEqual([
      { tag: 'text', text: 'Admin', style: ['bold'] },
      { tag: 'text', text: ' (Người đề xuất) đã gửi đề xuất.' },
    ]);
    expect(events[0].data.recipients.map((r: any) => r.name)).toEqual([
      'Thu Mua B',
    ]);
  });

  it('chủ đề cũ hỏng (tin gốc bị xoá) → mở chủ đề mới rồi trả lời', async () => {
    const { service, lark, events } = setup();
    await service.notify('ENTER_PURCHASING', 7, { actorId: 5 });
    lark.im.message.reply.mockImplementationOnce(() =>
      Promise.resolve({ code: 230011, msg: 'message deleted' } as any),
    );
    await service.notify('ENTER_ACCOUNTING', 7, { actorId: 5 });
    const groupCreates = lark.im.message.create.mock.calls.filter(
      ([p]: any) => p.params.receive_id_type === 'chat_id',
    );
    expect(groupCreates).toHaveLength(2);
    expect(events[1].data.group).toMatchObject({
      created: true,
      status: 'SENT',
    });
  });
});
