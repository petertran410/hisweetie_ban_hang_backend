import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SmaxService } from './smax.service';
import { SmaxApiService } from './smax-api.service';
import { decryptSmaxToken, encryptSmaxToken, jwtExpiry } from './smax-secret.util';

const pages = [
  { pid: 'zl1', name: 'Lermao OA', platform: 'zalo', active: true },
  { pid: 'zlw2', name: 'Diệp Trà Cs', platform: 'zaloweb', active: true },
  { pid: 'fb3', name: 'Fanpage', platform: 'facebook', active: true },
];

const makeService = (links: any[] = []) => {
  const prisma = {
    smaxChannelUser: {
      findMany: jest.fn().mockResolvedValue(links),
      findUnique: jest.fn(),
      upsert: jest.fn((args) => Promise.resolve(args)),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
  };
  const api = { listPages: jest.fn().mockResolvedValue(pages) };
  const audit = { create: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new SmaxService(prisma as any, api as any, audit as any),
    prisma,
  };
};

describe('SmaxService', () => {
  it('trả mọi kênh của biz (Zalo, Facebook…), ghép người dùng đã liên kết', async () => {
    const user = { id: 7, name: 'Sale A', email: 'a@x', phone: null };
    const { service } = makeService([
      { pagePid: 'zlw2', pageName: 'Diệp Trà Cs', platform: 'zaloweb', user },
    ]);

    const channels = await service.getZaloChannels();

    expect(channels.map((c) => c.pagePid)).toEqual(['zl1', 'zlw2', 'fb3']);
    expect(channels[0].users).toEqual([]);
    expect(channels[1].users).toEqual([user]);
  });

  it('liên kết tới kênh không còn trên Smax → missing', async () => {
    const { service } = makeService([
      {
        pagePid: 'zlw9',
        pageName: 'Kênh cũ',
        platform: 'zaloweb',
        user: { id: 1 },
      },
    ]);

    const channels = await service.getZaloChannels();
    const old = channels.find((c) => c.pagePid === 'zlw9');

    expect(old).toMatchObject({
      name: 'Kênh cũ',
      missing: true,
      active: false,
    });
  });

  it('1 kênh nhiều người dùng; gỡ từng người hoặc gỡ hết', async () => {
    const a = { id: 7, name: 'Sale A', email: 'a@x', phone: null };
    const b = { id: 8, name: 'Sale B', email: 'b@x', phone: null };
    const { service, prisma } = makeService([
      { pagePid: 'zlw2', pageName: 'Diệp Trà Cs', platform: 'zaloweb', user: a },
      { pagePid: 'zlw2', pageName: 'Diệp Trà Cs', platform: 'zaloweb', user: b },
    ]);

    const channels = await service.getZaloChannels();
    expect(channels.find((c) => c.pagePid === 'zlw2')?.users).toEqual([a, b]);

    await service.unlink('zlw2', 8);
    expect(prisma.smaxChannelUser.deleteMany).toHaveBeenLastCalledWith({ where: { pagePid: 'zlw2', userId: 8 } });
    await service.unlink('zlw2');
    expect(prisma.smaxChannelUser.deleteMany).toHaveBeenLastCalledWith({ where: { pagePid: 'zlw2' } });
  });

  it('sync: cập nhật tên/platform đã lưu khi kênh đổi trên Smax, bỏ qua kênh đã mất', async () => {
    const { service, prisma } = makeService([
      { pagePid: 'zlw2', pageName: 'Tên cũ', platform: 'zaloweb', user: { id: 7 } },
      { pagePid: 'zlw2', pageName: 'Tên cũ', platform: 'zaloweb', user: { id: 8 } },
      { pagePid: 'zl1', pageName: 'Lermao OA', platform: 'zalo', user: { id: 9 } },
      { pagePid: 'zlw-gone', pageName: 'Kênh đã xoá', platform: 'zaloweb', user: { id: 7 } },
    ]);
    const res = await service.syncZaloChannels();
    expect(res.updated).toBe(1);
    expect(prisma.smaxChannelUser.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.smaxChannelUser.updateMany).toHaveBeenCalledWith({
      where: { pagePid: 'zlw2' },
      data: { pageName: 'Diệp Trà Cs', platform: 'zaloweb' },
    });
    expect(res.channels.find((c) => c.pagePid === 'zlw-gone')?.missing).toBe(true);
  });

  it('link: lưu snapshot tên/platform (mọi loại kênh), chặn kênh không có trên Smax', async () => {
    const { service, prisma } = makeService();

    await service.link('zlw2', 7);
    expect(prisma.smaxChannelUser.upsert).toHaveBeenCalledWith({
      where: { pagePid_userId: { pagePid: 'zlw2', userId: 7 } },
      create: {
        pagePid: 'zlw2',
        userId: 7,
        pageName: 'Diệp Trà Cs',
        platform: 'zaloweb',
      },
      update: { pageName: 'Diệp Trà Cs', platform: 'zaloweb' },
    });

    await expect(service.link('zlw-x', 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await service.link('fb3', 7);
    expect(prisma.smaxChannelUser.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ create: { pagePid: 'fb3', userId: 7, pageName: 'Fanpage', platform: 'facebook' } }),
    );
  });
});

describe('SmaxApiService', () => {
  it('getThread: bình luận Facebook → link bài viết kèm comment_id; tin nhắn → không có link', async () => {
    const { of } = require('rxjs');
    const rows = [
      {
        tid: 'fb1222_fb2650', platform: 'facebook', type: 'facebook_comment', customer: { name: 'Mỹ Linh' },
        facebook: { id: '122241220328355350_1911242473407263', link: 'https://www.facebook.com/reel/2298586507567306/' },
      },
      { tid: 'fb2949', platform: 'facebook', type: 'facebook_message', customer: { name: 'Thư' }, facebook: { link: '/365228306663549/inbox/1/' } },
    ];
    const http = { request: jest.fn(() => of({ data: { data: rows.shift() } })) };
    const config = { get: (key: string, def?: string) => (key === 'SMAX_API_TOKEN' ? 'tok' : def) };
    const api = new SmaxApiService(http as any, config as any);
    expect(await api.getThread('fb3', 'fb1222_fb2650')).toMatchObject({
      isComment: true,
      commentUrl: 'https://www.facebook.com/reel/2298586507567306/?comment_id=1911242473407263',
    });
    expect(await api.getThread('fb3', 'fb2949')).toMatchObject({ isComment: false, commentUrl: null });
  });

  it('listRecentThreads: mọi nền tảng (Zalo cá nhân, Facebook, Shopee), tên/ảnh/SĐT/cờ trả lời', async () => {
    const { of } = require('rxjs');
    const http = {
      request: jest.fn(() =>
        of({
          data: {
            data: [
              { tid: 'zlw777', page_pid: 'zlw1', platform: 'zaloweb', zaloweb: { chat_type: 'group' }, customer: { name: 'Nhóm A' }, message: 'attach', read: false, reply_count: 3 },
              { tid: 'fb1222_fb2650', page_pid: 'fb3', platform: 'facebook', type: 'facebook_comment', customer: { name: 'Mỹ Linh' }, message: 'E muốn mua nguyên liệu ạ' },
              { tid: 'fb2949', page_pid: 'fb3', platform: 'facebook', type: 'facebook_message', controlled_by: 'META_AI', can_reply_message: false, phones: ['0913597795'], customer: { name: 'Thư Trần', picture: 'https://cdn/x.jpg' }, message: 'Bên mình có hàng chưa ạ', read: true },
              { tid: 'sp5089', page_pid: 'sp1', platform: 'shopee', customer: { name: 'ngoankim957', picture: '' }, message: 'Muốn trả hàng' },
              { tid: null, page_pid: 'x' },
            ],
          },
        }),
      ),
    };
    const config = { get: (key: string, def?: string) => (key === 'SMAX_API_TOKEN' ? 'tok' : def) };
    const api = new SmaxApiService(http as any, config as any);
    const threads = await api.listRecentThreads(['zlw1', 'fb3', 'sp1']);
    expect(threads.map((t) => [t.tid, t.platform, t.isComment, t.name, t.isGroup, t.canReply, t.phones])).toEqual([
      ['zlw777', 'zaloweb', false, 'Nhóm A', true, true, []],
      ['fb1222_fb2650', 'facebook', true, 'Mỹ Linh', false, true, []],
      ['fb2949', 'facebook', false, 'Thư Trần', false, false, ['0913597795']],
      ['sp5089', 'shopee', false, 'ngoankim957', false, true, []],
    ]);
    expect(threads[2].avatar).toBe('https://cdn/x.jpg');
    expect(threads.map((t) => t.controlledBy)).toEqual([null, null, 'META_AI', null]);
  });

  it('getFriendStatus: đọc is_friend / is_requested / is_requesting', async () => {
    const { of } = require('rxjs');
    const http = {
      request: jest.fn(() =>
        of({ data: { data: { error_code: 0, data: { is_friend: 0, is_requested: 0, is_requesting: 1 } } } }),
      ),
    };
    const config = { get: (key: string, def?: string) => (key === 'SMAX_API_TOKEN' ? 'tok' : def) };
    const api = new SmaxApiService(http as any, config as any);
    expect(await api.getFriendStatus('zlw1', '4546')).toEqual({
      isFriend: false,
      isRequested: false,
      isRequesting: true,
    });
  });

  it('Smax trả 400 có lý do → báo đúng lý do (không gộp thành "không kết nối được")', async () => {
    const { throwError } = require('rxjs');
    const http = {
      request: jest.fn(() =>
        throwError(() => ({
          response: {
            status: 400,
            data: { message: 'Bạn chưa thể gửi tin nhắn đến người này vì người này chặn không nhận tin nhắn từ người lạ.' },
          },
        })),
      ),
    };
    const config = { get: (key: string, def?: string) => (key === 'SMAX_API_TOKEN' ? 'tok' : def) };
    const api = new SmaxApiService(http as any, config as any);
    await expect(api.sendZaloweb('zlw1', { uid: '1' }, { message: 'hi' })).rejects.toMatchObject({
      status: 400,
      message: 'Zalo: Bạn chưa thể gửi tin nhắn đến người này vì người này chặn không nhận tin nhắn từ người lạ.',
    });
  });

  it('findFriendByPhone: đọc đúng 2 dạng response Zalo (tìm thấy / lỗi)', async () => {
    const { of } = require('rxjs');
    const responses = [
      { data: { error_code: 0, data: { uid: '4546', display_name: 'Trần Ngọc Nhân' } } },
      { data: { error_code: 0, data: 'enc', decodedData: { error_code: 216, data: null } } },
    ];
    const http = { request: jest.fn(() => of({ data: responses.shift() })) };
    const config = {
      get: (key: string, def?: string) => (key === 'SMAX_API_TOKEN' ? 'tok' : def),
    };
    const api = new SmaxApiService(http as any, config as any);

    expect(await api.findFriendByPhone('zlw1', '84901391300')).toEqual({
      uid: '4546',
      name: 'Trần Ngọc Nhân',
    });
    expect(await api.findFriendByPhone('zlw1', '84936708788')).toBeNull();
  });

  it('thiếu SMAX_API_TOKEN → 503', async () => {
    const config = {
      get: (key: string, def?: string) =>
        key === 'SMAX_API_TOKEN' ? undefined : def,
    };
    const api = new SmaxApiService({} as any, config as any);
    await expect(api.listPages()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('map response pages của Smax', async () => {
    const http = {
      request: jest.fn(() => {
        const { of } = require('rxjs');
        return of({
          data: {
            data: [
              {
                pid: 'zl1',
                name: 'OA',
                platform: 'zalo',
                active: true,
                extra: 1,
              },
              {
                // OA: admin cũ lỗi token nhưng admin khác còn token tốt → OK
                pid: 'zl9',
                name: 'Lermao OA',
                platform: 'zalo',
                active: true,
                members: [
                  {
                    access_token_error: '2026-04-21T05:02:03.493Z',
                    access_token_error_note: 'Invalid OAuth access token',
                  },
                  { name: 'Diệp Trà' },
                ],
              },
              {
                pid: 'zlw2',
                name: 'Diệp Trà Ms Vân Anh',
                platform: 'zaloweb',
                active: true,
                members: [
                  {
                    access_token_error: '2026-10-25T06:26:14.309Z',
                    access_token_error_note: 'zpw_sek bị thiếu hoặc không đúng',
                  },
                ],
              },
            ],
          },
        });
      }),
    };
    const config = {
      get: (key: string, def?: string) =>
        key === 'SMAX_API_TOKEN' ? 'tok' : def,
    };
    const api = new SmaxApiService(http as any, config as any);

    expect(await api.listPages()).toEqual([
      {
        pid: 'zl1',
        name: 'OA',
        picture: null,
        platform: 'zalo',
        active: true,
        connectionError: null,
      },
      {
        pid: 'zl9',
        name: 'Lermao OA',
        picture: null,
        platform: 'zalo',
        active: true,
        connectionError: null,
      },
      {
        pid: 'zlw2',
        name: 'Diệp Trà Ms Vân Anh',
        picture: null,
        platform: 'zaloweb',
        active: true,
        connectionError: {
          at: '2026-10-25T06:26:14.309Z',
          note: 'zpw_sek bị thiếu hoặc không đúng',
        },
      },
    ]);
    expect(http.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.smax.ai/partner/bizs/dieptra/pages',
      data: undefined,
      headers: { Authorization: 'Bearer tok' },
      timeout: 15000,
    });
  });
});

describe('SmaxService — token đăng nhập Smax', () => {
  const JWT = `h.${Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url')}.sigABCD`;
  beforeAll(() => {
    process.env.SMAX_TOKEN_ENCRYPTION_KEY = 'test-key';
  });

  const make = (check: { ok: boolean; invalid?: boolean; message?: string }) => {
    let stored: any = null;
    const prisma = {
      smaxUserToken: {
        findUnique: jest.fn(() => Promise.resolve(stored)),
        upsert: jest.fn((a) => ((stored = { ...a.create, updatedAt: new Date() }), Promise.resolve(stored))),
        deleteMany: jest.fn(() => ((stored = null), Promise.resolve({ count: 1 }))),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Admin' }) },
    };
    const api: any = {
      userTokenSource: 'env',
      hasEnvUserToken: true,
      activeUserToken: 'env-token-0000',
      checkUserToken: jest.fn().mockResolvedValue(check),
      useStoredUserToken: jest.fn((t: string | null) => {
        api.activeUserToken = t ?? 'env-token-0000';
        api.userTokenSource = t ? 'db' : 'env';
      }),
    };
    const audit = { create: jest.fn() };
    return { service: new SmaxService(prisma as any, api, audit as any), prisma, api, audit, get stored() { return stored; } };
  };

  it('mã hoá / giải mã được, sai dữ liệu → null; đọc hạn JWT', () => {
    const enc = encryptSmaxToken(JWT);
    expect(enc).not.toContain(JWT);
    expect(decryptSmaxToken(enc)).toBe(JWT);
    expect(decryptSmaxToken('enc:v1:00:00:00')).toBeNull();
    expect(jwtExpiry(JWT)?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(jwtExpiry('khong-phai-jwt')).toBeNull();
  });

  it('lưu: kiểm tra với Smax trước, lưu mã hoá, dùng ngay, audit không chứa token, trả 4 ký tự cuối', async () => {
    const t = make({ ok: true });
    const res = await t.service.setUserToken(`  Bearer ${JWT} `, { id: 1, name: 'Admin' });
    expect(t.api.checkUserToken).toHaveBeenCalledWith(JWT);
    expect(t.stored.token).toMatch(/^enc:v1:/);
    expect(decryptSmaxToken(t.stored.token)).toBe(JWT);
    expect(t.api.useStoredUserToken).toHaveBeenCalledWith(JWT);
    expect(JSON.stringify(t.audit.create.mock.calls)).not.toContain(JWT);
    expect(res).toMatchObject({ source: 'db', last4: 'ABCD', valid: true });
    expect(JSON.stringify(res)).not.toContain(JWT);
  });

  it('token sai: báo lỗi, không lưu, không đổi token đang dùng', async () => {
    const t = make({ ok: false, invalid: true, message: 'Token không hợp lệ hoặc đã hết hạn' });
    await expect(t.service.setUserToken(JWT, { id: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.prisma.smaxUserToken.upsert).not.toHaveBeenCalled();
    expect(t.api.useStoredUserToken).not.toHaveBeenCalled();
  });

  it('xoá: quay về token .env', async () => {
    const t = make({ ok: true });
    await t.service.setUserToken(JWT, { id: 1 });
    const res = await t.service.clearUserToken({ id: 1 });
    expect(t.api.useStoredUserToken).toHaveBeenLastCalledWith(null);
    expect(res.source).toBe('env');
  });
});
