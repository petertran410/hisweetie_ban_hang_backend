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
    expect(items[0]).toMatchObject({
      lastMessage: '[Tệp/ảnh]',
      channelName: 'Diệp Trà Cs',
      zaloId: '2395241168877084467',
      messageCount: 5,
      smaxUrl: `https://smax.ai/bizs/dieptra/chats/${PAGE}?tid=zlw2395241168877084467`,
    });
    expect((api as any).listRecentThreads).toHaveBeenCalledTimes(1);
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
      message: 'ok ạ',
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
