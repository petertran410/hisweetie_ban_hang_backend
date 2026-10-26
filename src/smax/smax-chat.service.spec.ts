import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import { safeFileName, SmaxChatService, vietQrUrl } from './smax-chat.service';

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
];
const links: Record<string, number> = { [PAGE]: 1, zlwBROKEN: 1, zlOA: 1, zlwOTHER: 2 };
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
    sendZaloweb: jest.fn().mockResolvedValue({ ok: true }),
    findFriendByPhone: jest.fn().mockResolvedValue(null),
    getFriendStatus: jest.fn().mockResolvedValue({ isFriend: true, isRequested: false, isRequesting: false }),
    requestFriend: jest.fn().mockResolvedValue({}),
    undoRequestFriend: jest.fn().mockResolvedValue({}),
    listGroupThreads: jest.fn().mockResolvedValue([
      { zaloId: '2395241168877084467', name: 'test group', memberPids: ['zlw1239621715347596858', 'zlwX'], lastMessageAt: null, avatar: null, memberPreview: [] },
      { zaloId: '777', name: 'Cộng đồng', memberPids: ['zlw1239621715347596858', 'zlwY', 'zlwZ'], lastMessageAt: null, avatar: null, memberPreview: [] },
      { zaloId: '888', name: 'Nhóm khác', memberPids: ['zlwY'], lastMessageAt: null },
    ]),
  };
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const config = { get: (k: string) => env[k] };
  return {
    service: new SmaxChatService(prisma as any, api as any, audit as any, {} as any, config as any),
    api,
    audit,
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

  it('chặn kênh không thuộc người gọi, kênh OA, contact của khách khác', async () => {
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
    ]);
    (service as any).prisma.customer.findMany = jest.fn().mockResolvedValue([
      { id: 77, code: 'KH005844', name: 'Mr Vũ' },
    ]);
    (api as any).listRecentThreads = jest.fn().mockResolvedValue([
      { tid: 'zlw2395241168877084467', pagePid: PAGE, name: 'test group', isGroup: true, lastMessage: 'attach', lastMessageAt: null, unread: true },
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
    expect(items[0]).toMatchObject({ lastMessage: '[Tệp/ảnh]', channelName: 'Diệp Trà Cs', zaloId: '2395241168877084467' });
    expect((api as any).listRecentThreads).toHaveBeenCalledTimes(1);
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
});
