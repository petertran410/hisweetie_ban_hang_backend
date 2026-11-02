import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { LeadsService } from './leads.service';

const CSKH = { id: 1, name: 'CSKH A', ownOnly: false };
const SALE_VIEW = { id: 9, name: 'Sale B', ownOnly: true };

const baseLead = {
  id: 7,
  name: 'Chị Thư',
  phone: '0913597795',
  phoneNormalized: '0913597795',
  zaloPhone: '0913597795' as string | null,
  zaloUid: null as string | null,
  source: 'facebook',
  category: 'cafe',
  need: 'Mua hồng bì',
  cskhNote: 'Khách ở Đồng Tháp',
  status: 'caring',
  salePicId: null as number | null,
  createdById: 1,
  conversations: [] as {
    tid: string;
    pagePid: string;
    isGroup: boolean;
    name: string | null;
  }[],
};

const makeService = (
  opts: {
    lead?: Partial<typeof baseLead>;
    sale?: Record<string, unknown> | null;
  } = {},
) => {
  const lead = { ...baseLead, ...opts.lead };
  let handover: any = null;
  const prisma: any = {
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(lead),
      findUniqueOrThrow: jest.fn().mockResolvedValue(lead),
      create: jest.fn(({ data }) => Promise.resolve({ id: 7, ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ ...lead, ...data })),
    },
    leadConversation: {
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    leadHandover: {
      create: jest.fn(({ data }) =>
        Promise.resolve((handover = { id: 50, ...data })),
      ),
      findUnique: jest.fn(() => Promise.resolve(handover)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(handover)),
      update: jest.fn(({ data }) =>
        Promise.resolve((handover = { ...handover, ...data })),
      ),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.sale === undefined
            ? { id: 9, name: 'Sale B', larkUserId: 'ou_sale', isActive: true }
            : opts.sale,
        ),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 9, name: 'Sale B', larkUserId: 'ou_sale' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    customerDebtPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    customerZaloContact: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    settings: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const smaxApi = {
    findFriendByPhone: jest
      .fn()
      .mockResolvedValue({ uid: '4546', name: 'Thư' }),
    requestFriend: jest.fn().mockResolvedValue({}),
    sendZaloweb: jest.fn().mockResolvedValue({ ok: true }),
  };
  const smaxChat = {
    myChannels: jest.fn().mockResolvedValue([
      {
        pagePid: 'zlwSALE',
        name: 'Zalo Sale B',
        platform: 'zaloweb',
        missing: false,
        connectionError: null,
      },
      {
        pagePid: 'fbPAGE',
        name: 'Fanpage',
        platform: 'facebook',
        missing: false,
        connectionError: null,
      },
    ]),
    userZaloChannel: jest
      .fn()
      .mockResolvedValue({ pid: 'zlwSALE', platform: 'zaloweb' }),
    assertSendRate: jest.fn(),
  };
  const larkClient = {
    im: { message: { create: jest.fn().mockResolvedValue({ code: 0 }) } },
  };
  const config = {
    get: (k: string) =>
      k === 'FRONTEND_URL' ? 'https://pos.example.com/' : undefined,
  };
  const larkDirectory = {
    openIdsInDepartments: jest.fn().mockResolvedValue(new Set(['ou_sale'])),
  };
  const service = new LeadsService(
    prisma,
    audit as any,
    smaxApi as any,
    smaxChat as any,
    larkClient as any,
    config as any,
    larkDirectory as any,
  );
  return {
    service,
    prisma,
    audit,
    smaxApi,
    smaxChat,
    larkClient,
    larkDirectory,
    getHandover: () => handover,
  };
};

const HANDOVER = {
  salePicId: 9,
  pagePid: 'zlwSALE',
  larkText: 'Lead mới: Chị Thư',
  friendMessage: 'Em là Sale B - LerMao',
  greeting: 'Dạ em chào Chị Thư',
  confirmed: true,
};

describe('LeadsService', () => {
  it('list: Sale (chỉ leads:view) chỉ thấy lead giao cho mình; lọc nguồn/trạng thái/tìm SĐT', async () => {
    const { service, prisma } = makeService();
    await service.list(
      { sources: 'facebook,tiktok', statuses: 'new', q: '+84 913' },
      SALE_VIEW,
    );
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { salePicId: 9 },
        { source: { in: ['facebook', 'tiktok'] } },
        { status: { in: ['new'] } },
        {
          OR: [
            { name: { contains: '+84 913', mode: 'insensitive' } },
            { phoneNormalized: { contains: '0913' } },
          ],
        },
      ]),
    );
    await service.list({}, CSKH);
    expect(prisma.lead.findMany.mock.calls[1][0].where).toEqual({});
  });

  it('list: kèm khách POS đã chuyển đổi và khách đã gắn hội thoại của lead (Zalo theo số, kênh khác theo tid + kênh)', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findMany.mockResolvedValue([
      {
        id: 1,
        customerId: null,
        conversations: [{ tid: 'fb2949', pagePid: 'fbPAGE' }],
      },
      {
        id: 2,
        customerId: 6,
        conversations: [{ tid: 'zlw4546', pagePid: 'zlwSALE' }],
      },
      {
        id: 3,
        customerId: null,
        conversations: [{ tid: 'fb2949', pagePid: 'fbOTHER' }],
      },
    ]);
    prisma.customerZaloContact.findMany.mockResolvedValue([
      {
        zaloId: 'fb2949',
        pagePid: 'fbPAGE',
        customer: { id: 5, code: 'TOANTEST', name: 'Toàn test' },
      },
      {
        zaloId: '4546',
        pagePid: null,
        customer: { id: 7, code: 'KH7', name: 'Thư' },
      },
    ]);
    prisma.customer.findMany.mockResolvedValue([
      { id: 6, code: 'KH6', name: 'Đã chuyển đổi' },
    ]);
    const { data } = await service.list({}, CSKH);
    expect(
      data.map((l: any) => [
        l.id,
        l.conversationCount,
        l.customers.map((c: any) => c.code),
      ]),
    ).toEqual([
      [1, 1, ['TOANTEST']],
      [2, 1, ['KH6', 'KH7']],
      [3, 1, []],
    ]);
    expect(prisma.customerZaloContact.findMany.mock.calls[0][0].where).toEqual({
      zaloId: { in: ['fb2949', '4546'] },
    });
  });

  it('Sale PIC: lead chưa có Sale mà đã gắn khách → lấy Sale PIC của khách (hiển thị + cron lưu)', async () => {
    const { service, prisma } = makeService();
    const leads = [
      {
        id: 1,
        name: 'A',
        createdById: 1,
        salePicId: null,
        customerId: 6,
        conversations: [],
      },
      {
        id: 2,
        name: 'B',
        createdById: 1,
        salePicId: 4,
        customerId: 6,
        conversations: [],
      },
      {
        id: 3,
        name: 'C',
        createdById: 1,
        salePicId: null,
        customerId: null,
        conversations: [],
      },
    ];
    prisma.lead.findMany.mockResolvedValue(leads);
    prisma.customer.findMany.mockResolvedValue([
      { id: 6, code: 'KH6', name: 'Khách' },
    ]);
    prisma.customerDebtPolicy.findMany.mockResolvedValue([
      { customerId: 6, salePicId: 9 },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 9, name: 'Sale B' }]);

    const { data } = await service.list({}, CSKH);
    expect(
      data.map((l: any) => [l.id, l.salePicId, l.salePicFromCustomer]),
    ).toEqual([
      [1, 9, true],
      [2, 4, false],
      [3, null, false],
    ]);

    prisma.lead.findMany.mockResolvedValue([leads[0], leads[2]]);
    expect(await service.syncSalePicFromCustomers()).toEqual({
      checked: 2,
      updated: 1,
    });
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { salePicId: 9 },
    });
  });

  it('get: Sale không xem được lead không giao cho mình', async () => {
    const { service } = makeService({
      lead: { salePicId: 3, handovers: [] } as any,
    });
    await expect(service.get(7, SALE_VIEW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('create: chuẩn hoá SĐT, SĐT Zalo mặc định = SĐT, CSKH = người tạo, kèm hội thoại Smax; cảnh báo trùng', async () => {
    const { service, prisma, audit } = makeService();
    prisma.customer.findMany.mockResolvedValue([
      { id: 5, code: 'KH5', name: 'Thư cũ' },
    ]);
    prisma.lead.findMany.mockResolvedValue([
      { id: 3, name: 'Thư', status: 'new' },
    ]);
    const res = await service.create(
      {
        name: ' Chị Thư ',
        phone: '+84 913 597 795',
        source: 'facebook',
        category: 'cafe',
        conversation: {
          pagePid: 'fbPAGE',
          tid: 'fb29490790703872140',
          platform: 'facebook',
          name: 'Thư Trần',
        },
      },
      CSKH,
    );
    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: 'Chị Thư',
      phoneNormalized: '0913597795',
      zaloPhone: '+84 913 597 795',
      cskhUserId: 1,
      createdById: 1,
      status: 'new',
      channelPid: 'fbPAGE',
      conversations: {
        create: [
          {
            pagePid: 'fbPAGE',
            tid: 'fb29490790703872140',
            platform: 'facebook',
            isGroup: false,
          },
        ],
      },
    });
    expect(res.duplicates).toEqual({
      customers: [{ id: 5, code: 'KH5', name: 'Thư cũ' }],
      leads: [{ id: 3, name: 'Thư', status: 'new' }],
    });
    expect(prisma.customer.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { contactNumber: { startsWith: '0913597795' } },
        { phone: { startsWith: '0913597795' } },
      ],
    });
    expect(audit.create.mock.calls[0][0]).toMatchObject({
      actionCode: 'LEAD_CREATE',
      entityType: 'leads',
    });
    await expect(
      service.create({ name: 'x', category: 'cafe' }, CSKH),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('convert: chép hội thoại sang khách đúng quy ước (Zalo cá nhân = số, kênh khác = tid + kênh), không ghi đè', async () => {
    const { service, prisma } = makeService({
      lead: {
        conversations: [
          {
            tid: 'zlw4546',
            pagePid: 'zlwSALE',
            isGroup: false,
            name: 'Thư Zalo',
          },
          {
            tid: 'zlw777',
            pagePid: 'zlwSALE',
            isGroup: true,
            name: 'Nhóm Thư',
          },
          { tid: 'fb2949', pagePid: 'fbPAGE', isGroup: false, name: 'Thư FB' },
        ],
      },
    });
    prisma.customer.findUnique.mockResolvedValue({
      id: 5,
      code: 'KH5',
      name: 'Thư',
    });
    // Khách đã có ID Zalo cá nhân → không ghi đè
    prisma.customerZaloContact.findMany.mockResolvedValue([
      { kind: 'user', zaloId: '999', pagePid: null },
    ]);
    const res = await service.convert(7, 5, CSKH);
    expect(
      prisma.customerZaloContact.create.mock.calls.map((c: any[]) => c[0].data),
    ).toEqual([
      expect.objectContaining({
        customerId: 5,
        kind: 'group',
        zaloId: '777',
        pagePid: null,
      }),
      expect.objectContaining({
        customerId: 5,
        kind: 'user',
        zaloId: 'fb2949',
        pagePid: 'fbPAGE',
      }),
    ]);
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({
      customerId: 5,
      status: 'converted',
    });
    expect(res.copiedConversations).toBe(2);
  });

  it('handoverCheck: nêu đủ lý do khoá (thiếu Zalo, Sale thiếu Lark ID / kênh Zalo)', async () => {
    const noZalo = makeService({
      lead: { zaloPhone: null },
      sale: { larkUserId: null, isActive: true },
    });
    noZalo.smaxChat.myChannels.mockResolvedValue([]);
    const r = await noZalo.service.handoverCheck(7, 9);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      'Lead chưa có SĐT Zalo cá nhân của khách',
      'Sale PIC chưa có Lark ID',
      'Sale PIC chưa liên kết kênh Zalo cá nhân trên Smax',
    ]);

    const ok = makeService();
    const r2 = await ok.service.handoverCheck(7, 9, 'zlwSALE');
    expect(r2).toMatchObject({
      ok: true,
      reasons: [],
      channels: [{ pagePid: 'zlwSALE' }],
    });
    const r3 = await ok.service.handoverCheck(7, 9, 'fbPAGE');
    expect(r3.reasons).toEqual(['Kênh Zalo không thuộc Sale PIC']);
  });

  it('handover: Lark → tra Zalo theo SĐT → kết bạn → tin chào; audit 3 bước; lead "Đã chuyển Sale"', async () => {
    const { service, prisma, audit, smaxApi, larkClient, getHandover } =
      makeService();
    const res = await service.handover(7, HANDOVER, CSKH);
    expect(larkClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_sale',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Lead mới: Chị Thư' }),
      },
    });
    expect(smaxApi.findFriendByPhone).toHaveBeenCalledWith(
      'zlwSALE',
      '84913597795',
    );
    expect(smaxApi.requestFriend).toHaveBeenCalledWith(
      'zlwSALE',
      '4546',
      'Em là Sale B - LerMao',
    );
    expect(smaxApi.sendZaloweb).toHaveBeenCalledWith(
      'zlwSALE',
      { uid: '4546' },
      { message: 'Dạ em chào Chị Thư' },
    );
    expect(
      audit.create.mock.calls.map((c: any[]) => [
        c[0].actionCode,
        c[0].metadata.status,
      ]),
    ).toEqual([
      ['LEAD_HANDOVER_LARK', 'ok'],
      ['LEAD_HANDOVER_FRIEND', 'ok'],
      ['LEAD_HANDOVER_GREETING', 'ok'],
    ]);
    expect(res.done).toBe(true);
    expect(getHandover().status).toBe('done');
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: 'handed_over', salePicId: 9 },
    });
    // ID Zalo tra được lưu lại cho lần sau
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { zaloUid: '4546' },
    });
  });

  it('handover lỗi giữa chừng → "partial"; gửi lại chỉ chạy bước lỗi, không gửi trùng bước đã thành công', async () => {
    const { service, smaxApi, larkClient, getHandover } = makeService();
    smaxApi.requestFriend.mockRejectedValueOnce(
      new Error('Zalo: Bạn đã gửi lời mời trước đó'),
    );
    const first = await service.handover(7, HANDOVER, CSKH);
    expect(first.done).toBe(false);
    expect(getHandover().steps).toMatchObject({
      lark: { status: 'ok' },
      friend: { status: 'failed', error: 'Zalo: Bạn đã gửi lời mời trước đó' },
      greeting: { status: 'ok' },
    });

    const retry = await service.retryHandover(50, true, CSKH);
    expect(retry.done).toBe(true);
    expect(larkClient.im.message.create).toHaveBeenCalledTimes(1);
    expect(smaxApi.sendZaloweb).toHaveBeenCalledTimes(1);
    expect(smaxApi.requestFriend).toHaveBeenCalledTimes(2);
  });

  it('handover: thiếu xác nhận → 400; không đủ điều kiện → 400 kèm lý do; vượt tần suất → 429', async () => {
    const { service, smaxChat, larkClient } = makeService();
    await expect(
      service.handover(7, { ...HANDOVER, confirmed: false }, CSKH),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.handover(7, { ...HANDOVER, pagePid: 'fbPAGE' }, CSKH),
    ).rejects.toThrow('Kênh Zalo không thuộc Sale PIC');
    smaxChat.assertSendRate.mockImplementationOnce(() => {
      throw new HttpException('Gửi quá nhanh', HttpStatus.TOO_MANY_REQUESTS);
    });
    await expect(service.handover(7, HANDOVER, CSKH)).rejects.toMatchObject({
      status: 429,
    });
    expect(larkClient.im.message.create).not.toHaveBeenCalled();
  });

  it('saleCandidates: chỉ nhân sự phòng ban Lark "Bộ Phận Sales"; Lark lỗi → mọi nhân sự', async () => {
    const { service, prisma, larkDirectory } = makeService();
    prisma.user.findMany.mockResolvedValue([{ id: 9, name: 'Sale B' }]);
    await expect(service.saleCandidates()).resolves.toEqual({
      users: [{ id: 9, name: 'Sale B' }],
      filtered: true,
      department: 'Bộ Phận Sales',
    });
    expect(larkDirectory.openIdsInDepartments).toHaveBeenCalledWith([
      'Bộ Phận Sales',
    ]);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
      larkUserId: { in: ['ou_sale'] },
    });

    larkDirectory.openIdsInDepartments.mockRejectedValueOnce(
      new Error('Lark down'),
    );
    const fallback = await service.saleCandidates();
    expect(fallback.filtered).toBe(false);
    expect(prisma.user.findMany.mock.calls[1][0].where).toEqual({
      isActive: true,
    });
  });

  it('handoverPreview: thay biến mẫu mặc định (tên khách, tên sale, link lead)', async () => {
    const { service } = makeService();
    const p = await service.handoverPreview(7, 9, 'Gọi sau 5h');
    expect(p.greeting).toBe(
      'Dạ em chào Chị Thư, em là Sale B từ LerMao. Em đã nhận được thông tin của mình từ bạn CSKH, em kết bạn Zalo để tiện tư vấn sản phẩm và báo giá cho mình ạ.',
    );
    expect(p.friendMessage).toBe('Em là Sale B - LerMao');
    expect(p.larkText).toContain('Khách: Chị Thư');
    expect(p.larkText).toContain('Phân loại: Khách quán');
    expect(p.larkText).toContain('Ghi chú CSKH: Gọi sau 5h');
    expect(p.larkText).toContain(
      'https://pos.example.com/khach-hang/lead?id=7',
    );
  });

  it('autoConvert: lead có SĐT trùng khách đã có hóa đơn (không huỷ) → tự chuyển đổi', async () => {
    const { service, prisma, audit } = makeService();
    prisma.lead.findMany.mockResolvedValue([
      { id: 7, phoneNormalized: '0913597795' },
    ]);
    prisma.customer.findFirst.mockResolvedValue({ id: 5 });
    prisma.customer.findUnique.mockResolvedValue({
      id: 5,
      code: 'KH5',
      name: 'Thư',
    });
    const res = await service.autoConvert();
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
      OR: [
        { contactNumber: { startsWith: '0913597795' } },
        { phone: { startsWith: '0913597795' } },
      ],
      invoices: { some: { status: { not: 2 } } },
    });
    expect(res).toEqual({ checked: 1, converted: 1 });
    expect(audit.create.mock.calls.at(-1)[0]).toMatchObject({
      actionCode: 'LEAD_AUTO_CONVERT',
      userId: 1,
    });
  });
});
