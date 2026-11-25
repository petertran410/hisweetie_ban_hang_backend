import type { AiScope } from '../ai-scope';
import type { AiToolContext } from './common';
import type { AiToolDeps } from './deps';
import { smaxChatsTool } from './smax-chats.tool';

// 10:00 ngày 22/11/2026 giờ VN
const NOW = new Date('2026-11-22T03:00:00Z');

const scope = (permissions = ['smax_chat:view']) =>
  ({
    userId: 9,
    userName: 'Sale B',
    can: (p: string) => permissions.includes(p),
  }) as unknown as AiScope;

const msg = (id: string, createdAt: string, text: string, fromMe = false) => ({
  id,
  text,
  type: 'message',
  fromMe,
  senderName: fromMe ? null : 'Chị Huệ',
  attachments: [],
  stickerId: null,
  stickerImage: null,
  quote: null,
  recalled: false,
  createdAt,
});

const makeDeps = () => ({
  prisma: { customer: { findFirst: jest.fn() } },
  smaxChat: {
    myChannels: jest.fn().mockResolvedValue([
      { pagePid: 'zlwA', name: 'Diệp Trà - Ms Mai Phương', missing: false },
      { pagePid: 'zlwB', name: 'Diệp Trà Cs', missing: false },
    ]),
    recentChats: jest.fn().mockResolvedValue({
      items: [
        {
          tid: 'zlw111',
          pagePid: 'zlwA',
          platform: 'zaloweb',
          channelName: 'Diệp Trà - Ms Mai Phương',
          name: 'Ms Huệ',
          isGroup: false,
          lastMessage: 'Gọi em 0912 345 678 nhé',
          lastMessageAt: '2026-11-22T02:00:00Z',
          unread: true,
          match: {
            type: 'linked',
            customer: { code: 'KH052280', name: 'Ms Huỳnh Huệ' },
          },
        },
        {
          tid: 'zlw222',
          pagePid: 'zlwA',
          platform: 'zaloweb',
          channelName: 'Diệp Trà - Ms Mai Phương',
          name: 'Khách cũ',
          isGroup: false,
          lastMessage: 'ok',
          lastMessageAt: '2026-11-20T02:00:00Z',
          unread: false,
          match: null,
        },
      ],
    }),
    getThreadMessages: jest.fn().mockResolvedValue({
      thread: { name: 'Ms Huệ' },
      messages: [
        msg('m0', '2026-11-21T16:00:00Z', 'Tin hôm qua'),
        msg(
          'm1',
          '2026-11-22T01:00:00Z',
          'Trà giao bị thiếu 2 hộp, sđt 0912345678',
        ),
        msg('m2', '2026-11-22T01:05:00Z', 'Dạ em kiểm tra ngay ạ', true),
      ],
      hasMore: false,
    }),
    getMessages: jest.fn(),
  },
});

const run = (
  deps: ReturnType<typeof makeDeps>,
  args: Record<string, unknown>,
  s = scope(),
) =>
  smaxChatsTool.run(
    {
      scope: s,
      now: NOW,
      deps: deps as unknown as AiToolDeps,
    } as AiToolContext,
    args,
  ) as Promise<Record<string, any>>;

describe('smax_chats', () => {
  it('chỉ mở với quyền smax_chat:view', () => {
    expect(smaxChatsTool.available(scope())).toBe(true);
    expect(smaxChatsTool.available(scope(['leads:view']))).toBe(false);
  });

  it('threads: chỉ kênh của người hỏi, lọc theo ngày, che SĐT', async () => {
    const deps = makeDeps();
    const result = await run(deps, {
      action: 'threads',
      channel: 'mai phuong',
    });
    expect(deps.smaxChat.myChannels).toHaveBeenCalledWith(9);
    expect(deps.smaxChat.recentChats).toHaveBeenCalledTimes(1);
    expect(deps.smaxChat.recentChats).toHaveBeenCalledWith(
      9,
      'zlwA',
      100,
      undefined,
    );
    expect(result.total).toBe(1);
    expect(result.threads[0]).toEqual(
      expect.objectContaining({
        ref: 'zlwA:zlw111',
        customer: 'KH052280 Ms Huỳnh Huệ',
        lastAt: '22/11 09:00',
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/0912/);
  });

  it('messages: đọc hội thoại có tin hôm nay, bỏ tin ngoài khoảng ngày', async () => {
    const deps = makeDeps();
    const result = await run(deps, {
      action: 'messages',
      channel: 'Mai Phương',
    });
    expect(deps.smaxChat.getThreadMessages).toHaveBeenCalledTimes(1);
    expect(deps.smaxChat.getThreadMessages).toHaveBeenCalledWith(
      9,
      'zlwA',
      'zlw111',
      undefined,
    );
    expect(result.threads[0].messages).toEqual([
      '08:00 Chị Huệ: Trà giao bị thiếu 2 hộp, sđt [SĐT]',
      '08:05 Kênh mình: Dạ em kiểm tra ngay ạ',
    ]);
  });

  it('đọc cả kênh theo trang: trả nextPage khi còn hội thoại', async () => {
    const deps = makeDeps();
    const today = (i: number) => ({
      tid: `zlw${i}`,
      pagePid: 'zlwA',
      channelName: 'Diệp Trà - Ms Mai Phương',
      name: `Khách ${i}`,
      lastMessage: '',
      lastMessageAt: new Date(
        Date.parse('2026-11-22T02:00:00Z') - i * 60_000,
      ).toISOString(),
      match: null,
    });
    deps.smaxChat.recentChats.mockResolvedValue({
      items: Array.from({ length: 30 }, (_, i) => today(i)),
    });
    const first = await run(deps, { action: 'messages', channel: 'Mai' });
    expect(first).toEqual(
      expect.objectContaining({ threadsActive: 30, page: 1, nextPage: 2 }),
    );
    deps.smaxChat.getThreadMessages.mockClear();
    const last = await run(deps, {
      action: 'messages',
      channel: 'Mai',
      page: 3,
    });
    expect(last.nextPage).toBeUndefined();
    expect(deps.smaxChat.getThreadMessages).toHaveBeenCalledTimes(6);
    expect(deps.smaxChat.getThreadMessages.mock.calls[0][2]).toBe('zlw24');
  });

  it('kênh không thuộc người hỏi → channel_not_found, không gọi Smax', async () => {
    const deps = makeDeps();
    const result = await run(deps, { action: 'messages', channel: 'Kênh lạ' });
    expect(result.error).toBe('channel_not_found');
    expect(deps.smaxChat.recentChats).not.toHaveBeenCalled();
  });

  it('kết quả dài bị cắt tin cũ để vừa giới hạn', async () => {
    const deps = makeDeps();
    deps.smaxChat.getThreadMessages.mockResolvedValue({
      thread: null,
      messages: Array.from({ length: 60 }, (_, i) =>
        msg(
          `x${i}`,
          new Date(
            Date.parse('2026-11-22T01:00:00Z') + i * 60_000,
          ).toISOString(),
          'a'.repeat(280),
        ),
      ),
      hasMore: false,
    });
    const result = await run(deps, {
      action: 'messages',
      threads: ['zlwA:zlw111'],
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
    expect(result.threads[0].olderNotRead).toBeGreaterThan(0);
  });
});
