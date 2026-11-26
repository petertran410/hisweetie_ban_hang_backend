import { SmaxArchiveService } from './smax-archive.service';
import {
  SmaxArchiveSyncService,
  LIST_LIMIT,
} from './smax-archive-sync.service';

const NOW = new Date('2026-11-26T03:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000;

const chatMsg = (
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  text: `tin ${id}`,
  type: 'message',
  fromMe: false,
  senderPid: 'zlw1',
  senderName: null,
  attachments: [],
  albumId: null,
  stickerId: null,
  stickerImage: null,
  quote: null,
  reactions: [],
  recalled: false,
  createdAt,
  ...extra,
});

const makePrisma = () => ({
  smaxMessage: {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  smaxThread: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn(),
  },
  smaxSyncChannel: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }: any) => data),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  process.env.SMAX_ARCHIVE_ENABLED = 'true';
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SMAX_ARCHIVE_ENABLED;
});

describe('SmaxArchiveService', () => {
  it('lưu tin: giữ cả tin cũ (lưu vĩnh viễn), bỏ trùng, cập nhật tin thu hồi và hội thoại', async () => {
    const prisma = makePrisma();
    const archive = new SmaxArchiveService(prisma as any);
    await archive.save('zlwA', 'zlw1', [
      chatMsg('old', iso(NOW.getTime() - 400 * 86_400_000)) as any,
      chatMsg('m1', iso(NOW.getTime() - min), { recalled: true }) as any,
    ]);
    const call = prisma.smaxMessage.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data.map((d: any) => d.msgPid)).toEqual(['old', 'm1']);
    expect(prisma.smaxMessage.updateMany).toHaveBeenCalledWith({
      where: { pagePid: 'zlwA', msgPid: { in: ['m1'] }, recalled: false },
      data: { recalled: true },
    });
    expect(
      prisma.smaxThread.upsert.mock.calls[0][0].update.lastMessageAt,
    ).toEqual(new Date(NOW.getTime() - min));
  });

  it('lưu khi POS tải tin: tắt cờ thì không ghi, lỗi DB không ném ra', async () => {
    const prisma = makePrisma();
    const archive = new SmaxArchiveService(prisma as any);
    process.env.SMAX_ARCHIVE_ENABLED = 'false';
    archive.saveQuietly('zlwA', 'zlw1', [
      chatMsg('m1', iso(NOW.getTime())) as any,
    ]);
    expect(prisma.smaxMessage.createMany).not.toHaveBeenCalled();

    process.env.SMAX_ARCHIVE_ENABLED = 'true';
    prisma.smaxMessage.createMany.mockRejectedValue(
      new Error('relation does not exist'),
    );
    expect(() =>
      archive.saveQuietly('zlwA', 'zlw1', [
        chatMsg('m1', iso(NOW.getTime())) as any,
      ]),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it('covered: cần lưu từ trước "from" và quét gần tới "to"', async () => {
    const prisma = makePrisma();
    const archive = new SmaxArchiveService(prisma as any);
    const dayStart = NOW.getTime() - 3 * 3_600_000;
    prisma.smaxSyncChannel.findUnique.mockResolvedValue({
      backfillFrom: new Date(dayStart - min),
      syncedUntil: new Date(NOW.getTime() - 3 * min),
    });
    await expect(
      archive.covered('zlwA', dayStart, NOW.getTime()),
    ).resolves.toBe(true);
    // Hỏi trước mốc bắt đầu lưu
    await expect(
      archive.covered('zlwA', dayStart - 3_600_000, NOW.getTime()),
    ).resolves.toBe(false);
    // Đồng bộ nền dừng > 10 phút
    prisma.smaxSyncChannel.findUnique.mockResolvedValue({
      backfillFrom: new Date(dayStart - min),
      syncedUntil: new Date(NOW.getTime() - 30 * min),
    });
    await expect(
      archive.covered('zlwA', dayStart, NOW.getTime()),
    ).resolves.toBe(false);
    process.env.SMAX_ARCHIVE_ENABLED = 'false';
    await expect(
      archive.covered('zlwA', dayStart, NOW.getTime()),
    ).resolves.toBe(false);
  });
});

describe('SmaxArchiveSyncService', () => {
  const page = {
    pid: 'zlwA',
    name: 'Kênh A',
    platform: 'zaloweb',
    active: true,
    picture: null,
    connectionError: null,
  };

  const setup = () => {
    const prisma = makePrisma();
    const archive = new SmaxArchiveService(prisma as any);
    jest.spyOn(archive, 'save');
    jest.spyOn(archive, 'upsertThread');
    const smaxApi = {
      listRecentThreads: jest.fn().mockResolvedValue([]),
      getMessages: jest.fn().mockResolvedValue([]),
      getThread: jest.fn().mockResolvedValue({ members: { zlw9: 'Chị Lan' } }),
    };
    const smaxChat = {
      normalize: jest.fn((raw: any[]) =>
        raw
          .map((m) => chatMsg(m.pid, m.created_at))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ),
    };
    const sync = new SmaxArchiveSyncService(
      prisma as any,
      smaxApi as any,
      smaxChat as any,
      archive,
    );
    return { prisma, archive, smaxApi, smaxChat, sync };
  };

  /** 20 tin / trang, mới → cũ, cách nhau 1 phút, bắt đầu từ `newest`. */
  const rawPage = (newest: number, count = 20) =>
    Array.from({ length: count }, (_, i) => ({
      pid: `p${newest - i * min}`,
      created_at: iso(newest - i * min),
    }));

  it('đọc lùi tới mốc đã lưu đủ (synced_through), kể cả khi khung chat đã lưu 20 tin mới nhất', async () => {
    const { prisma, smaxApi, archive, sync } = setup();
    const lastAt = NOW.getTime() - min;
    // Lần đồng bộ trước đủ tới 50 phút trước; khung chat POS đã lưu 20 tin mới nhất (không đụng synced_through)
    prisma.smaxThread.findUnique.mockResolvedValue({
      syncedThrough: new Date(lastAt - 50 * min),
    });
    smaxApi.getMessages
      .mockResolvedValueOnce(rawPage(lastAt))
      .mockResolvedValueOnce(rawPage(lastAt - 20 * min))
      .mockResolvedValueOnce(rawPage(lastAt - 40 * min));
    await sync.syncThread(
      page as any,
      { tid: 'zlw1', lastMessageAt: iso(lastAt), isGroup: false } as any,
      0,
    );
    // Đọc đủ 3 trang (trang 3 có tin cũ hơn mốc → dừng), không dừng ở tin đã có
    expect(smaxApi.getMessages).toHaveBeenCalledTimes(3);
    const saved = (archive.save as jest.Mock).mock.calls.flatMap((c) => c[2]);
    expect(saved).toHaveLength(51);
    expect(
      saved.every(
        (m: any) => new Date(m.createdAt).getTime() >= lastAt - 50 * min,
      ),
    ).toBe(true);
    expect(
      (archive.upsertThread as jest.Mock).mock.calls.at(-1)[2].syncedThrough,
    ).toEqual(new Date(lastAt));
    // Hội thoại 1-1 không cần lấy tên thành viên
    expect(smaxApi.getThread).not.toHaveBeenCalled();
  });

  it('bỏ qua hội thoại đã lưu đủ tới tin cuối', async () => {
    const { prisma, smaxApi, sync } = setup();
    prisma.smaxThread.findUnique.mockResolvedValue({
      syncedThrough: new Date(NOW.getTime()),
    });
    await sync.syncThread(
      page as any,
      { tid: 'zlw1', lastMessageAt: iso(NOW.getTime() - min) } as any,
      0,
    );
    expect(smaxApi.getMessages).not.toHaveBeenCalled();
  });

  it('nhóm: lấy tên thành viên từ thông tin thread', async () => {
    const { smaxApi, smaxChat, sync } = setup();
    smaxApi.getMessages.mockResolvedValueOnce(rawPage(NOW.getTime(), 3));
    await sync.syncThread(
      page as any,
      { tid: 'zlwg', lastMessageAt: iso(NOW.getTime()), isGroup: true } as any,
      0,
    );
    expect(smaxChat.normalize).toHaveBeenCalledWith(expect.any(Array), 'zlwA', {
      zlw9: 'Chị Lan',
    });
  });

  it(`danh sách đủ ${LIST_LIMIT} hội thoại → chia đôi khoảng thời gian, không sót`, async () => {
    const { smaxApi, sync } = setup();
    const from = new Date(NOW.getTime() - 60 * min);
    const t = (tid: string, at: number) => ({ tid, lastMessageAt: iso(at) });
    smaxApi.listRecentThreads.mockImplementation(
      async (_p: string[], _l: number, _k: unknown, r: any) =>
        r.from.getTime() === from.getTime() && r.to.getTime() === NOW.getTime()
          ? Array.from({ length: LIST_LIMIT }, (_, i) =>
              t(`x${i}`, NOW.getTime()),
            )
          : r.from.getTime() === from.getTime()
            ? [t('a', from.getTime() + min)]
            : [t('b', NOW.getTime()), t('a', NOW.getTime())],
    );
    const list = await sync.listWindow('zlwA', from, NOW);
    expect(list.map((x) => x.tid).sort()).toEqual(['a', 'b']);
    expect(smaxApi.listRecentThreads).toHaveBeenCalledTimes(3);
  });

  it('kênh mới: lấy bù 2 ngày chỉ với kênh được chọn, còn lại lưu từ lúc bật', async () => {
    const { prisma, smaxApi, sync } = setup();
    await sync.syncChannel({ ...page, pid: 'fb365228306663549' } as any, NOW);
    expect(
      prisma.smaxSyncChannel.create.mock.calls[0][0].data.backfillFrom,
    ).toEqual(new Date(NOW.getTime() - 2 * 86_400_000));
    await sync.syncChannel({ ...page, pid: 'zlwOther' } as any, NOW);
    expect(
      prisma.smaxSyncChannel.create.mock.calls[1][0].data.backfillFrom,
    ).toEqual(NOW);
    expect(smaxApi.listRecentThreads.mock.calls[0][3].from).toEqual(
      new Date(NOW.getTime() - 2 * 86_400_000),
    );
    expect(prisma.smaxSyncChannel.update).toHaveBeenLastCalledWith({
      where: { pagePid: 'zlwOther' },
      data: { syncedUntil: NOW, lastError: null, name: 'Kênh A' },
    });
  });

  it('backend tắt > 30 ngày: lượt sau quét bù cả khoảng đã lỡ, không cắt ở 30 ngày', async () => {
    const { prisma, smaxApi, sync } = setup();
    const day = 86_400_000;
    prisma.smaxSyncChannel.findUnique.mockResolvedValue({
      pagePid: 'zlwA',
      syncedUntil: new Date(NOW.getTime() - 45 * day),
      backfillFrom: new Date(NOW.getTime() - 90 * day),
    });
    await sync.syncChannel(page as any, NOW);
    expect(smaxApi.listRecentThreads.mock.calls[0][3].from).toEqual(
      new Date(NOW.getTime() - 45 * day - 5 * min),
    );
  });

  it('hội thoại lỗi: ghi lastError, không đẩy synced_until (lượt sau quét lại)', async () => {
    const { prisma, smaxApi, sync } = setup();
    prisma.smaxSyncChannel.findUnique.mockResolvedValue({
      pagePid: 'zlwA',
      syncedUntil: new Date(NOW.getTime() - 5 * min),
      backfillFrom: new Date(NOW.getTime() - 86_400_000),
    });
    smaxApi.listRecentThreads.mockResolvedValue([
      { tid: 'zlw1', lastMessageAt: iso(NOW.getTime()) },
    ]);
    smaxApi.getMessages.mockRejectedValue(new Error('Smax 500'));
    const result = await sync.syncChannel(page as any, NOW);
    expect(result.error).toContain('Smax 500');
    expect(prisma.smaxSyncChannel.update).toHaveBeenCalledTimes(1);
    expect(prisma.smaxSyncChannel.update.mock.calls[0][0].data).toEqual({
      lastError: expect.stringContaining('Smax 500'),
    });
  });
});
