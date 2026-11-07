import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import { isProxyableMediaUrl, isZaloMediaUrl, safeFileName, SmaxChatService, vietQrUrl } from './smax-chat.service';

const PAGE = 'zlw693698651694262958';
const pages = [
  { pid: PAGE, name: 'Diệp Trà Cs', platform: 'zaloweb', connectionError: null },
  {
    pid: 'zlwBROKEN',
    name: 'Vân Anh',
    platform: 'zaloweb',
    connectionError: { note: 'token', at: null },
  },
  { pid: 'zlOA', name: 'Lermao OA', platform: 'zalo', connectionError: null },
  { pid: 'fbPAGE', name: 'LerMao Fanpage', platform: 'facebook', connectionError: null },
];
const links: Record<string, number> = { [PAGE]: 1, zlwBROKEN: 1, zlOA: 1, fbPAGE: 1, zlwOTHER: 2 };
const contacts = [
  { id: 10, customerId: 5, kind: 'user', zaloId: '1239621715347596858' },
  { id: 11, customerId: 5, kind: 'group', zaloId: '2395241168877084467' },
  { id: 12, customerId: 6, kind: 'user', zaloId: '999999' },
];
const actor = { id: 1, name: 'Admin', canViewDebt: true };

const makeService = (env: Record<string, string> = {}) => {
  const prisma = {
    smaxChannelUser: {
      findUnique: jest.fn(({ where: { pagePid_userId: k } }) =>
        Promise.resolve(links[k.pagePid] === k.userId ? { pagePid: k.pagePid, userId: k.userId } : null),
      ),
      findMany: jest.fn(),
    },
    customerZaloContact: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(contacts.find((c) => c.id === where.id) ?? null),
      ),
      findMany: jest.fn(({ where }) =>
        Promise.resolve(contacts.filter((c) => c.customerId === where.customerId)),
      ),
    },
    customer: { findUnique: jest.fn().mockResolvedValue({ code: 'TOANTEST', totalDebt: 1250000 }) },
    invoice: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          (where.id.in as number[]).filter((id) => id === 7 || id === 8).map((id) => ({ id, code: `HD00000${id}` })),
        ),
      ),
    },
    leadConversation: { findMany: jest.fn().mockResolvedValue([]) },
    branch: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve({ 6: { name: 'Kho Hà Nội' }, 1: { name: 'Kho Sài Gòn' }, 4: { name: 'Văn phòng Hà Nội' } }[where.id] ?? null),
      ),
    },
    user: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          [
            { id: 50, name: 'Kho HN', larkUserId: 'ou_hn' },
            { id: 56, name: 'Kho SG', larkUserId: 'ou_sg' },
            { id: 16, name: 'Nguyễn Huyền Trang', larkUserId: 'ou_kt' },
          ].filter((u) => where.OR[0].larkUserId.in.includes(u.larkUserId) || where.OR[1].name.in.includes(u.name)),
        ),
      ),
    },
    packingSlipImage: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          [
            { id: 31, imageUrl: 'https://backendpos.hisweetievietnam.com/uploads/bao-don/a.jpg' },
            { id: 32, imageUrl: 'https://backendpos.hisweetievietnam.com/uploads/bao-don/b.jpg' },
          ].filter((r) => where.id.in.includes(r.id)),
        ),
      ),
    },
    productImage: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          [
            { id: 1, image: 'https://pos.example.com/uploads/products/a.jpg' },
            { id: 2, image: '/uploads/products/local.jpg' },
          ].filter((r) => where.id.in.includes(r.id)),
        ),
      ),
    },
    userBankAccount: {
      findUnique: jest.fn().mockResolvedValue({
        bankAccount: { bankName: 'MB', bankCode: 'MB', accountNumber: '3095686868', accountHolder: 'DIEP TRA' },
      }),
    },
  };
  const api = {
    listPages: jest.fn().mockResolvedValue(pages),
    getThread: jest.fn().mockResolvedValue({
      tid: 'zlw2395241168877084467',
      name: 'Nguyễn Toàn test group',
      chatType: 'group',
      members: { zlw1239621715347596858: 'Nguyễn Toàn' },
      memberAvatars: { zlw1239621715347596858: 'https://ava/1.jpg' },
    }),
    getMessages: jest.fn().mockResolvedValue([]),
    reactMessage: jest.fn().mockResolvedValue(undefined),
    getZaloAliases: jest.fn().mockResolvedValue(new Map()),
    renameCustomer: jest.fn((_p: string, _c: string, name: string) => Promise.resolve(name)),
    getMessageStates: jest.fn().mockResolvedValue(null),
    messageAction: jest.fn().mockResolvedValue(undefined),
    listFriendAvatars: jest.fn().mockResolvedValue({ zlwX: 'https://ava/x-moi.jpg' }),
    canReact: true,
    sendZaloweb: jest.fn().mockResolvedValue({ ok: true }),
    sendThreadMessage: jest.fn().mockResolvedValue({ ok: true }),
    findFriendByPhone: jest.fn().mockResolvedValue(null),
    getFriendStatus: jest.fn().mockResolvedValue({ isFriend: true, isRequested: false, isRequesting: false }),
    requestFriend: jest.fn().mockResolvedValue({}),
    undoRequestFriend: jest.fn().mockResolvedValue({}),
    bizAlias: 'dieptra',
    listGroupThreads: jest.fn().mockResolvedValue([
      { zaloId: '2395241168877084467', name: 'test group', memberPids: ['zlw1239621715347596858', 'zlwX'], lastMessageAt: null, avatar: null, memberPreview: [] },
      { zaloId: '777', name: 'Cộng đồng', memberPids: ['zlw1239621715347596858', 'zlwY', 'zlwZ'], lastMessageAt: null, avatar: null, memberPreview: [] },
      { zaloId: '888', name: 'Nhóm khác', memberPids: ['zlwY'], lastMessageAt: null },
    ]),
  };
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const config = { get: (k: string) => env[k] };
  const departments: Record<string, string[]> = { 'Kho Hà Nội': ['ou_hn'], 'Kho Sài Gòn': ['ou_sg'] };
  const lark = {
    openIdsInDepartments: jest.fn(async (names: string[]) => new Set(names.flatMap((n) => departments[n] ?? []))),
  };
  return {
    service: new SmaxChatService(prisma as any, api as any, audit as any, {} as any, config as any, lark as any),
    api,
    audit,
    lark,
  };
};

describe('SmaxChatService', () => {
  it('getMessages: tid = "zlw" + ID Zalo, chuẩn hoá & khử trùng theo pid', async () => {
    const { service, api } = makeService();
    api.getMessages.mockResolvedValue([
      { id: 'b', pid: 'm2', type: 'zaloweb_message', message: 'ok', sender_pid: PAGE, created_at: '2026-10-26T02:00:00Z' },
      { id: 'a', pid: 'm1', type: 'zaloweb_message', message: 'ok', sender_pid: 'zlw1239621715347596858', created_at: '2026-10-26T01:00:00Z', zaloweb: { group_layout_id: 'L1', sticker_id: '21237', attachments: [{ url: 'u', type: 'photo' }] } },
      { id: 'b2', pid: 'm2', type: 'zaloweb_message', message: 'ok', sender_pid: PAGE, created_at: '2026-10-26T02:00:00Z' },
    ]);

    const res = await service.getMessages(5, actor, PAGE, 11);

    expect(api.getMessages).toHaveBeenCalledWith(PAGE, 'zlw2395241168877084467', undefined);
    expect(res.thread).toEqual({ name: 'Nguyễn Toàn test group', chatType: 'group' });
    expect(res.senders).toEqual({ zlw1239621715347596858: { name: 'Nguyễn Toàn', avatar: 'https://ava/1.jpg' } });
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(res.messages[0]).toMatchObject({ fromMe: false, senderPid: 'zlw1239621715347596858', senderName: 'Nguyễn Toàn', albumId: 'L1', stickerId: '21237', attachments: [{ url: 'u', thumbnail: null, title: '', type: 'photo' }] });
    expect(res.messages[1]).toMatchObject({ fromMe: true, senderName: null, albumId: null });
  });

  it('normalize: ảnh/tệp/sticker Facebook (mime_type, url_preview, name, facebook.sticker)', () => {
    const { service } = makeService();
    const base = { type: 'facebook_message', platform: 'facebook', sender_pid: 'fbU', created_at: '2026-11-03T06:00:00Z' };
    const [img, file, sticker] = service.normalize(
      [
        {
          ...base,
          id: '1',
          pid: 'm1',
          facebook: { attachments: [{ mime_type: 'image', url: 'https://cdn/a.png', url_preview: 'https://cdn/a-s.png' }] },
        },
        {
          ...base,
          id: '2',
          pid: 'm2',
          created_at: '2026-11-03T06:01:00Z',
          facebook: { attachments: [{ mime_type: 'application/pdf', url: 'https://cdn/b.pdf', name: 'bao-gia.pdf' }] },
        },
        {
          ...base,
          id: '3',
          pid: 'm3',
          created_at: '2026-11-03T06:02:00Z',
          facebook: {
            sticker: 'https://fbcdn/s.png',
            attachments: [{ name: 'sticker-1', mime_type: 'image/png', url: 'https://fbcdn/s.png' }],
          },
        },
      ] as any,
      'fbPAGE',
      {},
    );
    expect(img.attachments).toEqual([{ url: 'https://cdn/a.png', thumbnail: 'https://cdn/a-s.png', title: '', type: 'image' }]);
    expect(file.attachments).toEqual([{ url: 'https://cdn/b.pdf', thumbnail: null, title: 'bao-gia.pdf', type: 'file' }]);
    expect(sticker.stickerImage).toBe('https://fbcdn/s.png');
    expect(sticker.attachments).toEqual([]);
  });

  it('normalize: sticker Zalo OA (attachment type "sticker") → stickerImage, không hiện "Tệp đính kèm"', () => {
    const { service } = makeService();
    const url = 'https://zalo-api.zadn.vn/api/emoticon/oasticker?eid=1&size=130';
    const [m] = service.normalize(
      [
        {
          id: '1',
          pid: 'zlA',
          type: 'zalo_message',
          platform: 'zalo',
          sender_pid: 'zlU',
          created_at: '2026-11-07T04:31:32Z',
          zalo: { id: 'A', attachments: [{ url, type: 'sticker' }] },
        },
      ] as any,
      'zlPAGE',
      {},
    );
    expect(m.stickerImage).toBe(url);
    expect(m.attachments).toEqual([]);
  });

  it('getMessages: Smax lỗi khi lấy thread vẫn trả tin nhắn', async () => {
    const { service, api } = makeService();
    api.getThread.mockRejectedValue(new Error('Smax 500'));
    api.getMessages.mockResolvedValue([
      { id: 'a', pid: 'm1', type: 'zaloweb_message', message: 'hi', sender_pid: PAGE, created_at: '2026-10-26T01:00:00Z' },
    ]);

    const res = await service.getMessages(5, actor, PAGE, 10);

    expect(res.thread).toBeNull();
    expect(res.messages).toHaveLength(1);
  });

  it('lookupByPhone: tách SĐT VN đầu tiên, đổi sang 84…', async () => {
    const { service, api } = makeService();
    for (const raw of ['0901391300.1', '090 139 1300', '090.139.1300', '+84 901 391 300']) {
      await service.lookupByPhone(1, PAGE, raw);
    }
    expect(api.findFriendByPhone.mock.calls.map((c) => c[1])).toEqual(
      Array(4).fill('84901391300'),
    );
    await expect(service.lookupByPhone(1, PAGE, '12345')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('scanSharedGroups: lọc nhóm có khách, đánh dấu đã lưu, cache chỉ mục theo kênh', async () => {
    const { service, api } = makeService();

    const res = await service.scanSharedGroups(5, 1, PAGE);
    await service.scanSharedGroups(5, 1, PAGE);

    expect(res.groups).toEqual([
      { zaloId: '2395241168877084467', name: 'test group', memberCount: 2, lastMessageAt: null, avatar: null, memberPreview: [], saved: true },
      { zaloId: '777', name: 'Cộng đồng', memberCount: 3, lastMessageAt: null, avatar: null, memberPreview: [], saved: false },
    ]);
    expect(res.truncated).toBe(false);
    expect(api.listGroupThreads).toHaveBeenCalledTimes(1);

    await service.scanSharedGroups(5, 1, PAGE, true);
    expect(api.listGroupThreads).toHaveBeenCalledTimes(2);
  });

  it('scanSharedGroups: khách chưa có ID Zalo cá nhân → 400', async () => {
    const { service } = makeService();
    await expect(service.scanSharedGroups(7, 1, PAGE)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('chặn kênh không thuộc người gọi, ID Zalo cá nhân dùng với kênh OA, contact của khách khác', async () => {
    const { service } = makeService();
    await expect(service.getMessages(5, actor, 'zlwOTHER', 10)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getMessages(5, actor, 'zlwNOPE', 10)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getMessages(5, actor, 'zlOA', 10)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getMessages(5, actor, PAGE, 12)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('send: chặn kênh mất kết nối và yêu cầu xác nhận ở môi trường thử nghiệm', async () => {
    const { service, api } = makeService();
    await expect(
      service.sendMessage(5, actor, { pagePid: 'zlwBROKEN', contactId: 10, text: 'hi', confirmed: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'hi' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(api.sendZaloweb).not.toHaveBeenCalled();
  });

  it('send: gửi uid cho chat trực tiếp, grid cho nhóm, ghi audit log', async () => {
    const { service, api, audit } = makeService();
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: ' chào ', confirmed: true });
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 11, text: 'nhóm', confirmed: true });

    expect(api.sendZaloweb).toHaveBeenNthCalledWith(1, PAGE, { uid: '1239621715347596858' }, { message: 'chào' });
    expect(api.sendZaloweb).toHaveBeenNthCalledWith(2, PAGE, { grid: '2395241168877084467' }, { message: 'nhóm' });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'SMAX_CHAT_SEND', entityCode: 'TOANTEST', userId: 1 }),
    );
  });

  it('production không cần confirmed; giới hạn 20 tin/phút/người', async () => {
    const { service, api } = makeService({ NODE_ENV: 'production' });
    for (let i = 0; i < 20; i++) {
      await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: `t${i}` });
    }
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'quá' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(api.sendZaloweb).toHaveBeenCalledTimes(20);
  });

  describe('gửi kèm tệp', () => {
    const env = { SMAX_MEDIA_PUBLIC_URL: 'https://pos.example.com/' };
    const img = (n: string) => ({ path: `smax-chat/${n}.jpg`, kind: 'image' as const, name: `${n}.jpg` });
    const pdf = { path: 'smax-chat/bao-gia.pdf', kind: 'file' as const, name: 'bao-gia.pdf' };
    let exists: jest.SpyInstance;
    beforeEach(() => {
      exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    });
    afterEach(() => exists.mockRestore());

    it('chữ 1 tin, ảnh gom 1 tin (album), mỗi tệp 1 tin riêng', async () => {
      const { service, api, audit } = makeService(env);
      await service.sendMessage(5, actor, {
        pagePid: PAGE,
        contactId: 10,
        text: 'Báo giá',
        attachments: [img('a'), pdf, img('b')],
        confirmed: true,
      });

      const u = 'https://pos.example.com/uploads/smax-chat';
      expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([
        { message: 'Báo giá' },
        { images: [`${u}/a.jpg`, `${u}/b.jpg`] },
        { file: `${u}/bao-gia.pdf` },
      ]);
      expect(audit.create.mock.calls[0][0].metadata).toMatchObject({ sentParts: 3, totalParts: 3 });
    });

    it('chỉ có tệp, không có chữ → chỉ gửi tệp', async () => {
      const { service, api } = makeService(env);
      await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, attachments: [pdf], confirmed: true });
      expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([
        { file: 'https://pos.example.com/uploads/smax-chat/bao-gia.pdf' },
      ]);
    });

    it('lỗi giữa chừng → báo đã gửi bao nhiêu phần, vẫn ghi audit', async () => {
      const { service, api, audit } = makeService(env);
      api.sendZaloweb.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Smax: không kết nối được'));
      await expect(
        service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'x', attachments: [pdf], confirmed: true }),
      ).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Đã gửi 1/2 phần') });
      expect(audit.create.mock.calls[0][0].metadata).toMatchObject({ sentParts: 1, totalParts: 2 });
    });

    it('chặn đường dẫn lạ / thiếu domain công khai', async () => {
      const { service, api } = makeService(env);
      for (const path of ['../.env', 'other/x.jpg', 'https://evil.com/x.jpg']) {
        await expect(
          service.sendMessage(5, actor, {
            pagePid: PAGE, contactId: 10, attachments: [{ path, kind: 'image', name: 'x' }], confirmed: true,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const local = makeService({ SMAX_MEDIA_PUBLIC_URL: 'http://localhost:3060' });
      await expect(
        local.service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, attachments: [pdf], confirmed: true }),
      ).rejects.toThrow('SMAX_MEDIA_PUBLIC_URL');
      expect(api.sendZaloweb).not.toHaveBeenCalled();
    });
  });

  it('đặt xe giao hàng: gửi grid vào nhóm cố định qua kênh cố định (không cần kênh của người bấm), ghi audit hóa đơn', async () => {
    const { service, api, audit } = makeService();
    const staff = { id: 3, name: 'Kho', canViewDebt: false }; // không liên kết kênh nào
    await expect(service.bookDelivery(staff, { invoiceId: 7, text: 'Đặt xe' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.bookDelivery(staff, { invoiceId: 999, text: 'Đặt xe', confirmed: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(api.sendZaloweb).not.toHaveBeenCalled();

    await service.bookDelivery(staff, { invoiceId: 7, text: ' Thông tin người gửi:\nKho ', confirmed: true });
    expect(api.sendZaloweb).toHaveBeenCalledWith(
      PAGE,
      { grid: '612515329498631054' },
      { message: 'Thông tin người gửi:\nKho' },
    );
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'SMAX_DELIVERY_BOOKING', entityType: 'invoices', entityCode: 'HD000007', userId: 3 }),
    );
    await expect(service.deliveryBookingTarget()).resolves.toMatchObject({
      channelName: 'Diệp Trà Cs',
      connectionError: false,
    });
  });

  it('đặt xe giao hàng nhiều hóa đơn: 1 tin, ghi audit từng hóa đơn; thiếu hóa đơn → 404', async () => {
    const { service, api, audit } = makeService();
    await expect(
      service.bookDelivery(actor, { invoiceIds: [7, 999], text: 'Đặt xe', confirmed: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.bookDelivery(actor, { text: 'Đặt xe', confirmed: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(api.sendZaloweb).not.toHaveBeenCalled();

    await service.bookDelivery(actor, { invoiceIds: [8, 7, 8], text: 'Người nhận 1\nNgười nhận 2', confirmed: true });
    expect(api.sendZaloweb).toHaveBeenCalledTimes(1);
    expect(audit.create).toHaveBeenCalledTimes(2);
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        entityCode: 'HD000007',
        message: expect.stringContaining('gộp chung chuyến với HD000008'),
      }),
    );
  });

  it('đặt xe giao hàng: kênh mất kết nối → 409, không gửi', async () => {
    const { service, api } = makeService({ SMAX_DELIVERY_PAGE_PID: 'zlwBROKEN' });
    await expect(
      service.bookDelivery(actor, { invoiceId: 7, text: 'Đặt xe', confirmed: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(api.sendZaloweb).not.toHaveBeenCalled();
  });

  it('đặt xe giao hàng: người gửi theo phòng ban Lark của chi nhánh, chi nhánh khác/Lark lỗi → mọi nhân sự', async () => {
    const { service, lark } = makeService();
    await expect(service.deliveryBookingSenders(6)).resolves.toEqual({ userIds: [50, 16] });
    await expect(service.deliveryBookingSenders(1)).resolves.toEqual({ userIds: [56] });
    await expect(service.deliveryBookingSenders(4)).resolves.toEqual({ userIds: null });
    lark.openIdsInDepartments.mockRejectedValueOnce(new Error('Lark down'));
    await expect(service.deliveryBookingSenders(1)).resolves.toEqual({ userIds: null });
  });

  it('safeFileName: bỏ dấu, ký tự lạ, giữ đuôi', () => {
    expect(safeFileName('Báo giá tháng 10 (Đợt 2).pdf')).toBe('Bao-gia-thang-10-Dot-2.pdf');
    expect(safeFileName('../../.env')).toBe('env');
    expect(safeFileName('???')).toBe('tep');
  });

  it('getPaymentInfo: QR đúng số nợ + mã KH; không có quyền công nợ → QR không kèm số tiền', async () => {
    const { service } = makeService();
    const info = await service.getPaymentInfo(5, actor);
    expect(info).toMatchObject({ bank: { accountNumber: '3095686868' }, amount: 1250000 });
    expect(info.qrUrl).toBe(
      'https://img.vietqr.io/image/MB-3095686868-compact1.png?amount=1250000&addInfo=TOANTEST&accountName=DIEP+TRA',
    );
    const noDebt = await service.getPaymentInfo(5, { ...actor, canViewDebt: false });
    expect(noDebt.amount).toBeNull();
    expect(noDebt.qrUrl).not.toContain('amount=');
  });

  it('gửi kèm ảnh QR: chỉ nhận link vietqr.io, gom vào album ảnh', async () => {
    const { service, api } = makeService();
    const qr = vietQrUrl({ bankCode: 'MB', accountNumber: '1', accountHolder: 'A' }, 5000, 'KH1');
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'Công nợ', qrImageUrl: qr, confirmed: true });
    expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([{ message: 'Công nợ' }, { images: [qr] }]);
    await expect(
      service.sendMessage(5, actor, {
        pagePid: PAGE, contactId: 10, qrImageUrl: 'https://evil.com/x.png', confirmed: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gửi kèm ảnh sản phẩm: tra URL theo id trong DB, gom album; chặn ảnh không https / id lạ', async () => {
    const { service, api } = makeService();
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'SP', productImageIds: [1], confirmed: true });
    expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([
      { message: 'SP' },
      { images: ['https://pos.example.com/uploads/products/a.jpg'] },
    ]);
    for (const ids of [[2], [99]]) {
      await expect(
        service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, productImageIds: ids, confirmed: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('gửi sticker: 1 tin riêng sau chữ; chặn mã sticker lạ', async () => {
    const { service, api } = makeService();
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'hi', stickerId: '21237', confirmed: true });
    expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([{ message: 'hi' }, { stickerId: '21237' }]);
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, stickerId: 'abc', confirmed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recentChats: khớp khách theo ID Zalo đã lưu, rồi theo mã khách trong tên nhóm; cache 30s', async () => {
    const { service, api } = makeService();
    (service as any).prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([
      { pagePid: PAGE, pageName: 'Diệp Trà Cs', platform: 'zaloweb', userId: 1 },
    ]);
    (service as any).prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([
      { id: 11, kind: 'group', zaloId: '2395241168877084467', customer: { id: 5, code: 'TOANTEST', name: 'Toàn test' } },
      { id: 13, kind: 'group', zaloId: '2395241168877084467', customer: { id: 6, code: 'KH6', name: 'Chi nhánh 2' } },
    ]);
    (service as any).prisma.customer.findMany = jest.fn().mockResolvedValue([
      { id: 77, code: 'KH005844', name: 'Mr Vũ' },
    ]);
    (api as any).listRecentThreads = jest.fn().mockResolvedValue([
      { tid: 'zlw2395241168877084467', pagePid: PAGE, name: 'test group', isGroup: true, lastMessage: 'attach', lastMessageAt: null, unread: true, messageCount: 5, avatar: null, memberPreview: [] },
      { tid: 'zlw3102735962735863553', pagePid: PAGE, name: 'TGNL VŨNG TÀU MR VŨ - DIỆP TRÀ kh005844', isGroup: true, lastMessage: 'hi', lastMessageAt: null, unread: false },
      { tid: 'zlw999', pagePid: PAGE, name: 'Nhóm lạ', isGroup: true, lastMessage: 'x', lastMessageAt: null, unread: false },
    ]);

    const { items } = await service.recentChats(1);
    await service.recentChats(1);

    expect(items.map((i) => [i.match?.type ?? null, i.match?.customer.id ?? null])).toEqual([
      ['linked', 5],
      ['byCode', 77],
      [null, null],
    ]);
    expect(items[0].match).toMatchObject({
      contactId: 11,
      customers: [
        { id: 5, code: 'TOANTEST', name: 'Toàn test', contactId: 11 },
        { id: 6, code: 'KH6', name: 'Chi nhánh 2', contactId: 13 },
      ],
    });
    expect(items[0]).toMatchObject({
      lastMessage: '[Tệp/ảnh]',
      channelName: 'Diệp Trà Cs',
      zaloId: '2395241168877084467',
      messageCount: 5,
      smaxUrl: `https://smax.ai/bizs/dieptra/chats/${PAGE}?tid=zlw2395241168877084467`,
    });
    expect((api as any).listRecentThreads).toHaveBeenCalledTimes(1);
  });

  describe('nhóm Zalo gắn nhiều khách', () => {
    const activityMocks = (prisma: any) => {
      prisma.order = {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, code: 'DH1', customerId: 6, orderDate: new Date('2026-10-30'), grandTotal: 100, statusValue: 'ok', orderStatus: null },
        ]),
      };
      prisma.invoice.findMany = jest.fn().mockResolvedValue([
        { id: 2, code: 'HD2', customerId: 5, purchaseDate: new Date('2026-10-29'), grandTotal: 200, debtAmount: 50, statusValue: 'ok' },
      ]);
    };

    it('getContext: nhóm kèm các khách khác cùng gắn (sharedWith)', async () => {
      const { service } = makeService();
      const prisma = (service as any).prisma;
      activityMocks(prisma);
      prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([]);
      prisma.customer.findUnique = jest.fn().mockResolvedValue({
        id: 5, code: 'TOANTEST', name: 'Toàn test', contactNumber: null, phone: null, totalDebt: 10, debtPolicy: null,
        zaloContacts: [{ id: 11, customerId: 5, kind: 'group', zaloId: '2395241168877084467', name: 'Nhóm' }],
      });
      prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([
        { id: 13, zaloId: '2395241168877084467', customer: { id: 6, code: 'KH6', name: 'Chi nhánh 2' } },
      ]);
      const ctx = await service.getContext(5, actor);
      expect(prisma.customerZaloContact.findMany.mock.calls[0][0].where).toEqual({
        zaloId: { in: ['2395241168877084467'] }, customerId: { not: 5 },
      });
      expect(ctx.contacts.groups[0].sharedWith).toEqual([{ id: 6, code: 'KH6', name: 'Chi nhánh 2', contactId: 13 }]);
    });
  });

  describe('kênh khác Zalo cá nhân (Zalo OA, Facebook, Shopee…)', () => {
    const OA_TID = 'zl7844228381489578393';

    it('đọc tin theo tid kênh khác, đính kèm ở m[platform]; không gọi API nội bộ thu hồi', async () => {
      const { service, api } = makeService();
      api.getMessages.mockResolvedValue([
        {
          id: 'x', pid: 'zld1a7', type: 'zalo_message', platform: 'zalo', sender_pid: OA_TID,
          created_at: '2026-11-01T07:52:45Z',
          zalo: { attachments: [{ url: 'https://zalo-api.zadn.vn/sticker.png', type: 'sticker' }] },
        },
      ]);
      const res = await service.getThreadMessages(1, 'zlOA', OA_TID);
      expect(api.getMessages).toHaveBeenCalledWith('zlOA', OA_TID, undefined);
      expect(api.getMessageStates).not.toHaveBeenCalled();
      expect(res.canReact).toBe(false);
      // Sticker Zalo OA hiện như sticker, không thành "Tệp đính kèm"
      expect(res.messages[0].stickerImage).toBe('https://zalo-api.zadn.vn/sticker.png');
      expect(res.messages[0].attachments).toEqual([]);
      await expect(service.getThreadMessages(1, 'zlOA', 'bad tid!')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('gửi qua thread (không qua zaloweb-messages): chữ kèm trả lời, ảnh QR thành picture; chặn sticker', async () => {
      const { service, api, audit } = makeService();
      const qr = vietQrUrl({ bankCode: 'MB', accountNumber: '1', accountHolder: 'A' }, 5000, 'KH1');
      await service.sendToThread(actor, {
        pagePid: 'zlOA', tid: OA_TID, text: 'Dạ shop gửi ạ', replyToPid: 'zld1a7c64d20fe65a73ce8', qrImageUrl: qr, confirmed: true,
      });
      expect(api.sendZaloweb).not.toHaveBeenCalled();
      expect(api.sendThreadMessage.mock.calls).toEqual([
        ['zlOA', OA_TID, { replyToPid: 'zld1a7c64d20fe65a73ce8', messages: [{ message: 'Dạ shop gửi ạ' }] }],
        ['zlOA', OA_TID, { messages: [{ picture: qr }] }],
      ]);
      expect(audit.create.mock.calls[0][0]).toMatchObject({ metadata: { platform: 'zalo', tid: OA_TID } });
      await expect(
        service.sendToThread(actor, { pagePid: 'zlOA', tid: OA_TID, stickerId: '21237', confirmed: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('thả cảm xúc, tra SĐT, quét nhóm chung chỉ có trên Zalo cá nhân', async () => {
      const { service } = makeService();
      await expect(
        service.reactMessage(actor, { pagePid: 'zlOA', tid: OA_TID, pid: 'zlw123456', reaction: 'LIKE', confirmed: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.lookupByPhone(1, 'zlOA', '0901391300')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.scanSharedGroups(5, 1, 'zlOA')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('gắn hội thoại kênh khác cho khách: lưu tid + pagePid; thiếu kênh / kênh Zalo cá nhân → 400', async () => {
      const { service } = makeService();
      const prisma = (service as any).prisma;
      prisma.customer.findUnique = jest.fn().mockResolvedValue({ id: 5 });
      prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([
        { id: 10, customerId: 5, kind: 'user', zaloId: '1239621715347596858', pagePid: null },
      ]);
      prisma.customerZaloContact.create = jest.fn(({ data }) => Promise.resolve({ id: 99, ...data }));
      prisma.customerZaloContact.update = jest.fn();
      const saved = await service.createContact(5, { id: 1, name: 'A' }, { kind: 'user', zaloId: OA_TID, pagePid: 'zlOA', name: 'Giang Ngô' });
      // Không ghi đè ID Zalo cá nhân đã có
      expect(prisma.customerZaloContact.update).not.toHaveBeenCalled();
      expect(saved).toMatchObject({ zaloId: OA_TID, pagePid: 'zlOA', kind: 'user' });
      await expect(service.createContact(5, { id: 1, name: 'A' }, { kind: 'user', zaloId: OA_TID })).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createContact(5, { id: 1, name: 'A' }, { kind: 'user', zaloId: OA_TID, pagePid: PAGE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('chat theo khách: hội thoại kênh khác chỉ dùng đúng kênh của nó', async () => {
      const { service, api } = makeService();
      const prisma = (service as any).prisma;
      prisma.customerZaloContact.findUnique = jest.fn().mockResolvedValue({
        id: 20, customerId: 5, kind: 'user', zaloId: OA_TID, pagePid: 'zlOA',
      });
      await service.getMessages(5, actor, 'zlOA', 20);
      expect(api.getMessages).toHaveBeenCalledWith('zlOA', OA_TID, undefined);
      await expect(service.getMessages(5, actor, PAGE, 20)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recentChats theo kênh khác: khớp tid đã lưu đúng trang, gợi ý khách theo SĐT', async () => {
      const { service, api } = makeService();
      const prisma = (service as any).prisma;
      prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([
        { pagePid: 'zlOA', pageName: 'Lermao OA', platform: 'zalo', userId: 1 },
      ]);
      prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([
        { id: 20, kind: 'user', zaloId: OA_TID, pagePid: 'zlOA', customer: { id: 5, code: 'TOANTEST', name: 'Toàn test' } },
      ]);
      prisma.customer.findMany = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 8, code: 'KH8', name: 'Chị Thư', contactNumber: '0913597795.1', phone: null }]);
      (api as any).listRecentThreads = jest.fn().mockResolvedValue([
        { tid: OA_TID, pagePid: 'zlOA', platform: 'zalo', isComment: false, controlledBy: null, name: 'Giang Ngô', isGroup: false, canReply: true, phones: [], lastMessage: 'hi', lastMessageAt: null, unread: true, messageCount: 2, avatar: null, memberPreview: [] },
        { tid: 'zl999', pagePid: 'zlOA', platform: 'zalo', isComment: false, controlledBy: null, name: 'Thư', isGroup: false, canReply: false, phones: ['+84913597795'], lastMessage: 'x', lastMessageAt: null, unread: false, messageCount: 1, avatar: null, memberPreview: [] },
      ]);
      const { items } = await service.recentChats(1, 'zlOA');
      prisma.leadConversation.findMany.mockResolvedValueOnce([
        { tid: 'zl999', pagePid: 'zlOA', lead: { id: 3, name: 'Thư', status: 'new' } },
      ]);
      prisma.customer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const again = await service.recentChats(1, 'zlOA', 31);
      expect(items.map((i) => [i.zaloId, i.match?.type, i.match?.customer.id, i.canReply])).toEqual([
        [OA_TID, 'linked', 5, true],
        ['zl999', 'byPhone', 8, false],
      ]);
      expect(again.items[1]).toMatchObject({ lead: { id: 3, name: 'Thư' }, phones: ['+84913597795'] });
    });
  });

  it('recentChats Facebook: gợi ý khách theo SĐT khách gõ trong tin và SĐT của lead đã gắn', async () => {
    const { service, api } = makeService();
    const prisma = (service as any).prisma;
    prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([
      { pagePid: 'fbPAGE', pageName: 'Fanpage', platform: 'facebook', userId: 1 },
    ]);
    prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([]);
    prisma.leadConversation.findMany.mockResolvedValueOnce([
      { tid: 'fb222', pagePid: 'fbPAGE', lead: { id: 4, name: 'Linh', status: 'new', phoneNormalized: '0941889555' } },
    ]);
    prisma.customer.findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 8, code: 'KH8', name: 'Thu Hiền', contactNumber: '0365692400', phone: null },
        { id: 9, code: 'KH9', name: 'Linh', contactNumber: null, phone: '0941889555.1' },
      ]);
    (api as any).listRecentThreads = jest.fn().mockResolvedValue([
      { tid: 'fb111', pagePid: 'fbPAGE', platform: 'facebook', isComment: false, name: 'Thu Hiền Ngô', isGroup: false, canReply: true, phones: [], lastMessage: 'sđt em 0365 692 400 nha', lastMessageAt: null, unread: true, messageCount: 1, avatar: null, memberPreview: [] },
      { tid: 'fb222', pagePid: 'fbPAGE', platform: 'facebook', isComment: false, name: 'Linh', isGroup: false, canReply: true, phones: [], lastMessage: 'hi', lastMessageAt: null, unread: false, messageCount: 1, avatar: null, memberPreview: [] },
      { tid: 'fb333', pagePid: 'fbPAGE', platform: 'facebook', isComment: false, name: 'Lạ', isGroup: false, canReply: true, phones: [], lastMessage: 'giá bao nhiêu', lastMessageAt: null, unread: false, messageCount: 1, avatar: null, memberPreview: [] },
    ]);
    const { items } = await service.recentChats(1, 'fbPAGE');
    expect(items.map((i) => [i.tid, i.match?.type ?? null, i.match?.customer.code ?? null, i.lead?.id ?? null])).toEqual([
      ['fb111', 'byPhone', 'KH8', null],
      ['fb222', 'byPhone', 'KH9', 4],
      ['fb333', null, null, null],
    ]);
  });

  describe('Meta Business AI (Messenger)', () => {
    const FB_TID = 'fb29490790703872140';

    it('bật: gọi pass-control qua API nội bộ + audit; chặn hội thoại bình luận và kênh không phải Facebook', async () => {
      const { service, api, audit } = makeService();
      (api as any).passControlBizAI = jest.fn().mockResolvedValue(undefined);
      api.getThread.mockResolvedValueOnce({ tid: FB_TID, name: 'Thư Trần', isComment: false, controlledBy: 'SMAXAI' });
      await service.passControlBizAI(actor, { pagePid: 'fbPAGE', tid: FB_TID, confirmed: true });
      expect((api as any).passControlBizAI).toHaveBeenCalledWith('fbPAGE', FB_TID);
      expect(audit.create.mock.calls[0][0]).toMatchObject({ actionCode: 'SMAX_META_AI_ON', entityId: FB_TID });

      api.getThread.mockResolvedValueOnce({ tid: 'fb1_fb2', name: 'x', isComment: true });
      await expect(service.passControlBizAI(actor, { pagePid: 'fbPAGE', tid: 'fb1_fb2', confirmed: true })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.passControlBizAI(actor, { pagePid: 'zlOA', tid: 'zl123456', confirmed: true })).rejects.toBeInstanceOf(BadRequestException);
      expect((api as any).passControlBizAI).toHaveBeenCalledTimes(1);
    });

    it('tắt: gửi tin Messenger kèm thẻ HUMAN_AGENT (chỉ fanpage Facebook)', async () => {
      const { service, api } = makeService();
      await service.sendToThread(actor, { pagePid: 'fbPAGE', tid: FB_TID, text: 'Dạ em hỗ trợ ạ', humanAgent: true, confirmed: true });
      expect(api.sendThreadMessage).toHaveBeenCalledWith('fbPAGE', FB_TID, {
        messages: [{ message: 'Dạ em hỗ trợ ạ', message_tag: 'HUMAN_AGENT' }],
      });
      await service.sendToThread(actor, { pagePid: 'zlOA', tid: 'zl123456', text: 'hi', humanAgent: true, confirmed: true });
      expect(api.sendThreadMessage).toHaveBeenLastCalledWith('zlOA', 'zl123456', { messages: [{ message: 'hi' }] });
    });
  });

  it('recentChats tìm kiếm: gửi keyword cho Smax, chỉ giữ hội thoại khớp tên (không dấu, không phân biệt hoa thường)', async () => {
    const { service, api } = makeService();
    (service as any).prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([
      { pagePid: PAGE, pageName: 'Diệp Trà Cs', platform: 'zaloweb', userId: 1 },
    ]);
    (service as any).prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([]);
    (service as any).prisma.customer.findMany = jest.fn().mockResolvedValue([]);
    (api as any).listRecentThreads = jest.fn().mockResolvedValue([
      { tid: 'zlw1', pagePid: PAGE, name: 'Diệp Trà - Ms Thúy - Tân Phú', isGroup: true, lastMessage: 'a', lastMessageAt: null, unread: false },
      // Smax khớp do thành viên / nội dung tin → bỏ
      { tid: 'zlw2', pagePid: PAGE, name: 'CỘNG ĐỒNG LERMAO HƯNG YÊN', isGroup: true, lastMessage: 'chị Thúy ơi', lastMessageAt: null, unread: false },
      { tid: 'zlw3', pagePid: PAGE, name: 'THUY NGUYEN', isGroup: false, lastMessage: 'b', lastMessageAt: null, unread: false },
    ]);

    const { items } = await service.recentChats(1, undefined, 50, '  thúy ');

    expect(items.map((i) => i.tid)).toEqual(['zlw1', 'zlw3']);
    expect((api as any).listRecentThreads).toHaveBeenCalledWith([PAGE], 50, 'thúy');
  });

  it('recentChats: tên gợi nhớ Zalo của kênh ưu tiên hơn tên Smax (chỉ 1-1), tìm được theo tên gợi nhớ', async () => {
    const { service, api } = makeService();
    (service as any).prisma.smaxChannelUser.findMany = jest.fn().mockResolvedValue([
      { pagePid: PAGE, pageName: 'Diệp Trà Cs', platform: 'zaloweb', userId: 1 },
    ]);
    (service as any).prisma.customerZaloContact.findMany = jest.fn().mockResolvedValue([]);
    (service as any).prisma.customer.findMany = jest.fn().mockResolvedValue([]);
    (api as any).getZaloAliases = jest.fn().mockResolvedValue(new Map([['zlw3', 'Hải RT - Lermao HP'], ['zlw1', 'không áp cho nhóm']]));
    (api as any).listRecentThreads = jest.fn().mockResolvedValue([
      { tid: 'zlw1', pagePid: PAGE, name: 'Báo đơn', isGroup: true, lastMessage: 'a', lastMessageAt: null, unread: false },
      { tid: 'zlw3', pagePid: PAGE, name: 'Hải RT', isGroup: false, lastMessage: 'b', lastMessageAt: null, unread: false },
    ]);

    const { items } = await service.recentChats(1);
    expect(items.map((i) => i.name)).toEqual(['Báo đơn', 'Hải RT - Lermao HP']);
    const found = await service.recentChats(1, undefined, 30, 'lermao');
    expect(found.items.map((i) => i.tid)).toEqual(['zlw3']);
    // Tên gợi nhớ cache theo kênh
    expect((api as any).getZaloAliases).toHaveBeenCalledTimes(1);
  });

  it('renameThread: đổi tên trên Smax (customer pid = tid), ghi audit; chặn tên rỗng / kênh không phải Zalo cá nhân', async () => {
    const { service, api, audit } = makeService();
    const tid = 'zlw2395241168877084467';
    const res = await service.renameThread(actor, { pagePid: PAGE, tid, name: '  Báo   đơn HN ' });
    expect(api.renameCustomer).toHaveBeenCalledWith(PAGE, tid, 'Báo đơn HN');
    expect(res).toEqual({ name: 'Báo đơn HN', alias: null });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'SMAX_THREAD_RENAME', entityId: tid, metadata: expect.objectContaining({ from: 'Nguyễn Toàn test group', to: 'Báo đơn HN' }) }),
    );
    await expect(service.renameThread(actor, { pagePid: PAGE, tid, name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.renameThread(actor, { pagePid: 'zlOA', tid: 'zl123456', name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    expect(api.renameCustomer).toHaveBeenCalledTimes(1);
    // Trùng tên đang hiện (tên gợi nhớ) → không gọi Smax
    (api as any).getZaloAliases = jest.fn().mockResolvedValue(new Map([[tid, 'Báo đơn Kho HN']]));
    (service as any).aliasCache.clear();
    expect(await service.renameThread(actor, { pagePid: PAGE, tid, name: 'Báo đơn Kho HN' })).toEqual({ name: 'Báo đơn Kho HN', alias: 'Báo đơn Kho HN' });
    expect(api.renameCustomer).toHaveBeenCalledTimes(1);
  });

  it('friendAction: đồng ý = gửi lời mời lại, thu hồi = undo; chỉ cho Zalo cá nhân; ghi audit', async () => {
    const { service, api, audit } = makeService();
    const res = await service.friendAction(5, actor, { pagePid: PAGE, contactId: 10, action: 'accept' });
    expect(api.requestFriend).toHaveBeenCalledWith(PAGE, '1239621715347596858', 'Xin chào, mình là Diệp Trà Cs');
    expect(res.friend).toEqual({ isFriend: true, isRequested: false, isRequesting: false });
    await service.friendAction(5, actor, { pagePid: PAGE, contactId: 10, action: 'undo' });
    expect(api.undoRequestFriend).toHaveBeenCalledWith(PAGE, '1239621715347596858');
    expect(audit.create.mock.calls.map((c) => c[0].actionCode)).toEqual(['SMAX_FRIEND_ACTION', 'SMAX_FRIEND_ACTION']);
    await expect(
      service.friendAction(5, actor, { pagePid: PAGE, contactId: 11, action: 'request' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hội thoại chưa gắn khách: đọc / gửi theo tid (uid hoặc grid), chặn tid lạ và kênh của người khác', async () => {
    const { service, api, audit } = makeService();
    await service.getThreadMessages(1, PAGE, 'zlw45460453502640815');
    expect(api.getMessages).toHaveBeenCalledWith(PAGE, 'zlw45460453502640815', undefined);

    await service.sendToThread(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', text: 'hi', confirmed: true });
    await service.sendToThread(actor, { pagePid: PAGE, tid: 'zlw777', isGroup: true, text: 'nhóm', confirmed: true });
    expect(api.sendZaloweb.mock.calls.map((c) => c[1])).toEqual([{ uid: '45460453502640815' }, { grid: '777' }]);
    expect(audit.create.mock.calls[0][0]).toMatchObject({ entityType: 'smax_threads', entityId: 'zlw45460453502640815' });

    await expect(service.getThreadMessages(1, PAGE, '../x')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getThreadMessages(1, 'zlwOTHER', 'zlw777')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('trả lời: phần chữ qua thread kèm reply_to_pid; chuyển tiếp ảnh/tệp Zalo', async () => {
    const { service, api } = makeService();
    await service.sendMessage(5, actor, {
      pagePid: PAGE,
      contactId: 10,
      text: 'ok ạ',
      replyToPid: 'zlw8420175530134',
      forwardMedia: [
        { url: 'https://photo-stal-35.zdn.vn/no/jpg/a/b.jpg', kind: 'image' },
        { url: 'https://do36.dlfl.vn/9b60/4779', kind: 'file' },
      ],
      confirmed: true,
    });
    expect(api.sendThreadMessage).toHaveBeenCalledWith(PAGE, 'zlw1239621715347596858', {
      replyToPid: 'zlw8420175530134',
      messages: [{ message: 'ok ạ' }],
    });
    expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([
      { images: ['https://photo-stal-35.zdn.vn/no/jpg/a/b.jpg'] },
      { file: 'https://do36.dlfl.vn/9b60/4779' },
    ]);
  });

  it('trả lời: Smax báo 5xx nhưng tin đã tới → coi là đã gửi (tránh gửi trùng khi thử lại)', async () => {
    const { service, api, audit } = makeService();
    api.sendThreadMessage.mockRejectedValueOnce(new BadGatewayException('Smax: không kết nối được'));
    api.getMessages.mockResolvedValueOnce([
      { pid: 'zlw1', sender_pid: PAGE, message: 'ok ạ', created_at: new Date().toISOString() },
    ]);
    await service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'ok ạ', replyToPid: 'zlw8420215128116', confirmed: true });
    expect(audit.create).toHaveBeenCalled();

    // Không thấy tin trên Smax → vẫn báo lỗi
    api.sendThreadMessage.mockRejectedValueOnce(new BadGatewayException('Smax: không kết nối được'));
    api.getMessages.mockResolvedValueOnce([]);
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'lần 2', replyToPid: 'zlw8420215128116', confirmed: true }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('báo đơn: 1 ảnh gửi trước chữ, nhiều ảnh gửi chữ trước; cần quyền xem Báo đơn', async () => {
    const { service, api } = makeService();
    const slipActor = { ...actor, canViewPackingSlips: true };
    await service.sendMessage(5, slipActor, {
      pagePid: PAGE, contactId: 10, text: '🎉 Báo đơn BD1', packingSlipImageIds: [31], imagesFirst: true, confirmed: true,
    });
    expect(api.sendZaloweb.mock.calls.map((c) => c[2])).toEqual([
      { images: ['https://backendpos.hisweetievietnam.com/uploads/bao-don/a.jpg'] },
      { message: '🎉 Báo đơn BD1' },
    ]);
    api.sendZaloweb.mockClear();
    await service.sendMessage(5, slipActor, {
      pagePid: PAGE, contactId: 10, text: '🎉 Báo đơn BD2', packingSlipImageIds: [31, 32], confirmed: true,
    });
    expect(api.sendZaloweb.mock.calls.map((c) => Object.keys(c[2]))).toEqual([['message'], ['images']]);
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, text: 'x', packingSlipImageIds: [31], confirmed: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cảm xúc: gộp theo icon, đánh dấu của kênh; thả/thu hồi qua API nội bộ + audit', async () => {
    const { service, api, audit } = makeService();
    api.getMessages.mockResolvedValueOnce([
      {
        pid: 'zlw1', sender_pid: 'zlwX', message: 'ok', created_at: new Date().toISOString(),
        zaloweb: {
          customer_reactions: [
            { customer_pid: 'zlwX', customer_name: 'Khách', icons: [{ name: 'HEART', number: 2 }] },
            { customer_pid: PAGE, customer_name: 'Kênh', icons: [{ name: 'HEART', number: 1 }, { name: 'LIKE', number: 1 }] },
          ],
        },
      },
    ]);
    const page = await service.getThreadMessages(1, PAGE, 'zlw45460453502640815');
    expect(page.canReact).toBe(true);
    expect(page.messages[0].reactions).toEqual([
      { icon: 'HEART', count: 3, mine: true, users: [{ name: 'Khách', avatar: null }, { name: 'Kênh', avatar: null }] },
      { icon: 'LIKE', count: 1, mine: true, users: [{ name: 'Kênh', avatar: null }] },
    ]);

    // Avatar bạn bè tải ngầm → lần tải sau dùng ảnh mới
    expect(api.listFriendAvatars).toHaveBeenCalledWith(PAGE);
    await new Promise((r) => setImmediate(r));
    api.getMessages.mockResolvedValueOnce([
      {
        pid: 'zlw2', sender_pid: 'zlwX', message: 'a', created_at: new Date().toISOString(),
        zaloweb: { customer_reactions: [{ customer_pid: 'zlwX', customer_name: 'Khách', customer_picture: 'https://ava/cu.jpg', icons: [{ name: 'LIKE' }] }] },
      },
    ]);
    const page2 = await service.getThreadMessages(1, PAGE, 'zlw45460453502640815');
    expect(page2.messages[0].reactions[0].users[0].avatar).toBe('https://ava/x-moi.jpg');

    await service.reactMessage(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', pid: 'zlw8420215128116', reaction: 'NONE', confirmed: true });
    expect(api.reactMessage).toHaveBeenCalledWith(PAGE, 'zlw45460453502640815', 'zlw8420215128116', 'NONE');
    expect(audit.create.mock.calls.at(-1)[0]).toMatchObject({ actionCode: 'SMAX_CHAT_REACT' });
    await expect(
      service.reactMessage(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', pid: 'zlw8420215128116', reaction: 'KISS', confirmed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reactMessage(actor, { pagePid: 'zlwOTHER', tid: 'zlw45460453502640815', pid: 'zlw8420215128116', reaction: 'LIKE', confirmed: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('thu hồi / xoá tin: gộp trạng thái API nội bộ, ẩn tin đã xoá phía mình; gọi API + audit', async () => {
    const { service, api, audit } = makeService();
    const at = new Date().toISOString();
    api.getMessages.mockResolvedValueOnce([
      { pid: 'zlw1', sender_pid: PAGE, message: 'đã thu hồi', created_at: at },
      { pid: 'zlw2', sender_pid: 'zlwX', message: 'đã xoá phía mình', created_at: at },
      { pid: 'zlw3', sender_pid: 'zlwX', message: 'thường', created_at: at },
    ]);
    api.getMessageStates.mockResolvedValueOnce(
      new Map([
        ['zlw1', { status: 'deleted' }],
        ['zlw2', { status: 'sent', deleted: { at } }],
        ['zlw3', { status: 'sent' }],
      ]),
    );
    const page = await service.getThreadMessages(1, PAGE, 'zlw45460453502640815', '2026-10-30T00:00:00.000Z');
    expect(api.getMessageStates).toHaveBeenCalledWith(PAGE, 'zlw45460453502640815', '2026-10-30T00:00:00.000Z');
    expect(page.messages.map((m) => [m.id, m.recalled])).toEqual([['zlw1', true], ['zlw3', false]]);
    expect(page.hasMore).toBe(false);

    // API nội bộ lỗi → vẫn trả tin như thường
    api.getMessages.mockResolvedValueOnce([{ pid: 'zlw4', sender_pid: PAGE, message: 'x', created_at: at }]);
    api.getMessageStates.mockRejectedValueOnce(new Error('401'));
    const page2 = await service.getThreadMessages(1, PAGE, 'zlw45460453502640815');
    expect(page2.messages.map((m) => [m.id, m.recalled])).toEqual([['zlw4', false]]);

    await service.messageAction(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', pid: 'zlw8420215128116', action: 'recall', confirmed: true });
    expect(api.messageAction).toHaveBeenCalledWith(PAGE, 'zlw45460453502640815', 'zlw8420215128116', 'recall');
    expect(audit.create.mock.calls.at(-1)[0]).toMatchObject({ actionCode: 'SMAX_CHAT_RECALL' });
    await service.messageAction(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', pid: 'zlw8420215128116', action: 'delete', confirmed: true });
    expect(audit.create.mock.calls.at(-1)[0]).toMatchObject({ actionCode: 'SMAX_CHAT_DELETE' });
    await expect(
      service.messageAction(actor, { pagePid: PAGE, tid: 'zlw45460453502640815', pid: 'abc', action: 'recall', confirmed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.messageAction(actor, { pagePid: 'zlwOTHER', tid: 'zlw45460453502640815', pid: 'zlw8420215128116', action: 'delete', confirmed: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chặn chuyển tiếp/tải link ngoài Zalo và trả lời không có chữ', async () => {
    const { service } = makeService();
    expect(isZaloMediaUrl('https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=1')).toBe(true);
    expect(isZaloMediaUrl('https://evil.com/zdn.vn/x.jpg')).toBe(false);
    expect(isZaloMediaUrl('http://photo.zdn.vn/x.jpg')).toBe(false);
    // Tải qua backend: thêm ảnh QR VietQR (mẫu in), không mở cho chuyển tiếp
    expect(isProxyableMediaUrl('https://img.vietqr.io/image/BIDV-1-compact1.png?amount=0')).toBe(true);
    expect(isZaloMediaUrl('https://img.vietqr.io/image/BIDV-1-compact1.png')).toBe(false);
    expect(isProxyableMediaUrl('https://img.vietqr.io.evil.com/x.png')).toBe(false);
    await expect(
      service.sendMessage(5, actor, {
        pagePid: PAGE, contactId: 10, forwardMedia: [{ url: 'https://evil.com/a.jpg', kind: 'image' }], confirmed: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.sendMessage(5, actor, { pagePid: PAGE, contactId: 10, stickerId: '1', replyToPid: 'zlw1', confirmed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.fetchZaloMedia('https://evil.com/a.jpg')).rejects.toBeInstanceOf(BadRequestException);
  });
});
