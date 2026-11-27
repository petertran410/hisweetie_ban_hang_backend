import type { ArchiveRow } from '../rules/rule-engine';
import {
  buildState,
  ContextBuilder,
  PREVIOUS_LIMIT,
  redact,
} from './context-builder';

const T0 = new Date('2026-11-27T03:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const row = (
  id: number,
  min: number,
  over: Partial<ArchiveRow> = {},
): ArchiveRow => ({
  id: BigInt(id),
  pagePid: 'zlwOUR1',
  tid: 'zlw900001',
  msgPid: `m${id}`,
  senderPid: 'zlw555',
  senderName: 'Chị Lan',
  fromMe: false,
  type: 'message',
  text: `tin ${id}`,
  attachments: null,
  sticker: null,
  recalled: false,
  createdAt: at(min),
  ...over,
});

describe('redact', () => {
  it('che SĐT, email, link, số dài, người được tag; giữ số lượng / giá thường', () => {
    const out = redact(
      'Gọi 0912 345 678 hoặc mail lan.nguyen@gmail.com, xem https://shop.vn/x?a=1, STK 0123456789012 @Nguyễn Văn A lấy 2 thùng 1.250.000đ',
    );
    expect(out).not.toMatch(/0912|gmail|shop\.vn|0123456789012|Nguyễn/);
    expect(out).toContain('[SĐT]');
    expect(out).toContain('[email]');
    expect(out).toContain('[link]');
    expect(out).toContain('[số]');
    expect(out).toContain('2 thùng 1.250.000đ');
  });
});

describe('buildState', () => {
  const target = row(10, 10, { text: 'Lại như lần trước à em?' });

  it('chỉ lấy tin trước tin đích (không lấy tin tương lai), sắp theo thời gian, tối đa 5 tin', () => {
    const previous = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      row: row(i, i),
      staff: i % 2 === 0,
    }));
    const future = { row: row(11, 11), staff: false };
    const sameTimeLaterId = { row: row(12, 10), staff: false };
    const state = buildState({
      target,
      isGroup: false,
      previous: [future, ...previous.reverse(), sameTimeLaterId],
      quoted: null,
    });
    expect(state.previous.map((p) => p.text)).toEqual([
      'tin 3',
      'tin 4',
      'tin 5',
      'tin 6',
      'tin 7',
    ]);
    expect(state.previous).toHaveLength(PREVIOUS_LIMIT);
  });

  it('chat riêng: khách là customer; nhóm: other_member (không mặc định là khách); nhân viên là staff', () => {
    const prev = [{ row: row(1, 1), staff: true }];
    expect(
      buildState({ target, isGroup: false, previous: prev, quoted: null }),
    ).toMatchObject({
      conversation_type: 'private',
      target: { role: 'customer', text: 'Lại như lần trước à em?' },
      previous: [{ role: 'staff' }],
    });
    expect(
      buildState({ target, isGroup: true, previous: [], quoted: null }).target
        .role,
    ).toBe('other_member');
  });

  it('không gửi tên người gửi, link tệp; ảnh thành [ảnh]; trích dẫn được che như nội dung', () => {
    const t = row(10, 10, {
      text: 'em xem giúp',
      attachments: [{ type: 'image', url: 'https://zalo.me/secret.jpg' }],
    });
    const state = buildState({
      target: t,
      isGroup: false,
      previous: [],
      quoted: { text: 'SĐT chị 0912345678', staff: true },
    });
    const json = JSON.stringify(state);
    expect(json).not.toMatch(/Chị Lan|secret\.jpg|0912345678/);
    expect(state.target.text).toBe('em xem giúp [ảnh]');
    expect(state.quoted).toEqual({ role: 'staff', text: 'SĐT chị [SĐT]' });
  });
});

describe('ContextBuilder.build', () => {
  const make = (
    previousRows: ArchiveRow[],
    opts: { sentByUs?: string[]; backfillFrom?: Date; isGroup?: boolean } = {},
  ) => {
    const prisma = {
      smaxThread: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ isGroup: opts.isGroup ?? true }),
      },
      smaxSyncChannel: {
        findUnique: jest.fn().mockResolvedValue({
          backfillFrom: opts.backfillFrom ?? new Date('2026-04-01T00:00:00Z'),
        }),
      },
      smaxMessage: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(previousRows)
          .mockResolvedValueOnce(
            (opts.sentByUs ?? []).map((msgPid) => ({ msgPid })),
          ),
      },
    };
    return { prisma, builder: new ContextBuilder(prisma as any) };
  };

  it('truy vấn tin trước theo (created_at, id) < tin đích, cùng page_pid / tid, bỏ tin thu hồi', async () => {
    const target = row(10, 10);
    const { prisma, builder } = make([row(9, 9), row(8, 8)]);
    await builder.build(target, new Set(['zlwOUR1']));
    const [{ where }] = prisma.smaxMessage.findMany.mock.calls[0] as [
      { where: { OR: unknown } },
    ];
    expect(where).toMatchObject({
      pagePid: 'zlwOUR1',
      tid: 'zlw900001',
      type: 'message',
      recalled: false,
    });
    expect(where.OR).toEqual([
      { createdAt: { lt: target.createdAt } },
      { createdAt: target.createdAt, id: { lt: 10n } },
    ]);
  });

  it('tin trước do kênh khác của công ty gửi (from_me ở kênh đó) → staff', async () => {
    const { builder } = make(
      [row(9, 9, { msgPid: 'k9' }), row(8, 8, { msgPid: 'k8' })],
      { sentByUs: ['k9'] },
    );
    const { state } = await builder.build(row(10, 10), new Set(['zlwOUR1']));
    expect(state.previous.map((p) => p.role)).toEqual([
      'other_member',
      'staff',
    ]);
  });

  it('context_partial khi thiếu tin trước mà kênh mới bắt đầu lưu sát trước tin đích', async () => {
    const recent = make([], { backfillFrom: at(-60) });
    expect(
      (await recent.builder.build(row(10, 10), new Set())).contextPartial,
    ).toBe(true);
    const old = make([row(9, 9)]);
    expect(
      (await old.builder.build(row(10, 10), new Set())).contextPartial,
    ).toBe(false);
  });
});
