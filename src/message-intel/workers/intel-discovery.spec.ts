import type { ArchiveRow } from '../rules/rule-engine';
import {
  IntelDiscoveryService,
  SCAN_BATCH,
  SETTLE_MS,
} from './intel-discovery.service';

const NOW = new Date('2026-11-27T10:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const row = (id: number, over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  id: BigInt(id),
  pagePid: 'zlwA',
  tid: 'zlw900001',
  msgPid: `m${id}`,
  senderPid: 'zlw555',
  senderName: 'Chị Lan',
  fromMe: false,
  type: 'message',
  text: 'Cho chị 2 thùng trà xanh nhé',
  attachments: null,
  sticker: null,
  recalled: false,
  createdAt: ago(60),
  ...over,
});

function make(
  opts: {
    rows?: ArchiveRow[];
    siblings?: ArchiveRow[];
    runtime?: object;
    activatedAt?: Date;
  } = {},
) {
  const runtime = {
    discoveryCursor: 0n,
    backfillStatus: null,
    ...opts.runtime,
  };
  const prisma = {
    smaxMessage: {
      // Truy vấn có lọc msg_pid = nạp dòng cùng tin; còn lại = quét theo con trỏ / backfill
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { msgPid?: { in: string[] } } }) =>
            Promise.resolve(
              where.msgPid
                ? (opts.siblings ?? opts.rows ?? []).filter((r) =>
                    where.msgPid!.in.includes(r.msgPid),
                  )
                : (opts.rows ?? []),
            ),
        ),
    },
    smaxMessageIntel: {
      createMany: jest
        .fn()
        .mockImplementation(({ data }: { data: unknown[] }) =>
          Promise.resolve({ count: data.length }),
        ),
    },
    smaxIntelRuntime: { update: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn(),
  };
  const intel = {
    activeVersion: jest.fn().mockResolvedValue({ id: 7 }),
    activatedAt: jest.fn().mockResolvedValue(opts.activatedAt ?? ago(120)),
    runtime: jest.fn().mockResolvedValue(runtime),
    ourPagePids: jest.fn().mockResolvedValue(new Set(['zlwA', 'zlwB'])),
  };
  return {
    prisma,
    intel,
    svc: new IntelDiscoveryService(prisma as any, intel as any),
  };
}
type Job = {
  msgPid: string;
  status: string;
  skipReason?: string;
  intent?: string;
};
const jobs = (prisma: ReturnType<typeof make>['prisma']) =>
  (prisma.smaxMessageIntel.createMany.mock.calls as unknown[][])[0]?.[0] as
    | { data: Job[]; skipDuplicates: boolean }
    | undefined;

// Không phụ thuộc .env của máy chạy test
beforeEach(() => delete process.env.MESSAGE_INTEL_PAGE_PIDS);
afterEach(() => delete process.env.MESSAGE_INTEL_PAGE_PIDS);

describe('IntelDiscoveryService.discover', () => {
  it('chỉ xử lý tin đã "lắng", con trỏ dừng trước tin mới nhất chưa đủ thời gian', async () => {
    const rows = [
      row(1),
      row(2),
      row(3, { createdAt: new Date(NOW.getTime() - SETTLE_MS + 60_000) }),
      row(4),
    ];
    const { prisma, svc } = make({ rows });
    expect(await svc.discover(NOW)).toBe(2);
    expect(jobs(prisma)!.data.map((j) => j.msgPid)).toEqual(['m1', 'm2']);
    expect(jobs(prisma)!.skipDuplicates).toBe(true);
    expect(prisma.smaxIntelRuntime.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { discoveryCursor: 2n },
    });
  });

  it('tin tạo trước khi bật phiên bản quá 1 ngày (vd vừa tải tin cũ) không tạo job, để backfill; con trỏ vẫn chạy', async () => {
    const { prisma, svc } = make({
      rows: [row(1, { createdAt: ago(3 * 24 * 60) })],
      activatedAt: ago(120),
    });
    expect(await svc.discover(NOW)).toBe(0);
    expect(prisma.smaxMessageIntel.createMany).not.toHaveBeenCalled();
    expect(prisma.smaxIntelRuntime.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { discoveryCursor: 1n },
    });
  });
});

describe('IntelDiscoveryService.createJobs', () => {
  it('nạp đủ dòng cùng msg_pid ở các kênh: kênh khác from_me → nhân viên; xác nhận → nhãn luật; còn lại pending', async () => {
    const rows = [
      row(1, { msgPid: 'k' }),
      row(2, { text: 'dạ' }),
      row(3),
      row(4, { type: 'system' }),
    ];
    const siblings = [
      ...rows,
      row(9, { msgPid: 'k', pagePid: 'zlwB', fromMe: true }),
    ];
    const { prisma, svc } = make({ siblings });
    await svc.createJobs(rows, 7);
    const where = (
      (prisma.smaxMessage.findMany.mock.calls as unknown[][])[0][0] as {
        where: { pagePid: { in: string[] } };
      }
    ).where;
    expect(where.pagePid.in.sort()).toEqual(['zlwA', 'zlwB']);
    const byPid = Object.fromEntries(
      jobs(prisma)!.data.map((j) => [j.msgPid, j]),
    );
    expect(byPid.k).toMatchObject({ status: 'skipped', skipReason: 'staff' });
    expect(byPid.m2).toMatchObject({
      status: 'completed',
      intent: 'acknowledgment',
    });
    expect(byPid.m3).toMatchObject({ status: 'pending' });
    expect(byPid.m4).toBeUndefined();
  });

  it('MESSAGE_INTEL_PAGE_PIDS: chỉ tạo job cho tin có ở kênh được bật', async () => {
    process.env.MESSAGE_INTEL_PAGE_PIDS = 'zlwB';
    const siblings = [
      row(1),
      row(2, { msgPid: 'g' }),
      row(3, { msgPid: 'g', pagePid: 'zlwB' }),
    ];
    const { prisma, svc } = make({ siblings });
    await svc.createJobs(siblings, 7);
    expect(jobs(prisma)!.data.map((j) => j.msgPid)).toEqual(['g']);
  });
});

describe('IntelDiscoveryService.backfill', () => {
  it('không chạy khi chưa bật backfill', async () => {
    const { prisma, svc } = make();
    expect(await svc.backfill()).toEqual({ created: 0, more: false });
    expect(prisma.smaxMessage.findMany).not.toHaveBeenCalled();
  });

  it('lọc theo khoảng ngày / kênh, hết tin thì chuyển done', async () => {
    const rows = [
      row(5, { createdAt: ago(60) }),
      row(6, { createdAt: ago(10 * 24 * 60) }),
      row(7, { pagePid: 'zlwB' }),
    ];
    const { prisma, svc } = make({
      rows,
      runtime: {
        backfillStatus: 'running',
        backfillCursor: 4n,
        backfillUntilId: 100n,
        backfillFrom: ago(2 * 24 * 60),
        backfillTo: NOW,
        backfillPagePids: ['zlwA'],
      },
    });
    expect(await svc.backfill()).toEqual({ created: 1, more: false });
    expect(jobs(prisma)!.data.map((j) => j.msgPid)).toEqual(['m5']);
    expect(prisma.smaxIntelRuntime.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { backfillCursor: 7n, backfillStatus: 'done' },
    });
    expect(rows.length).toBeLessThan(SCAN_BATCH);
  });
});
