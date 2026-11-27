import type { AiScope } from '../ai-scope';
import type { AiToolContext } from './common';
import { smaxMessageLabelsTool } from './smax-message-labels.tool';

// 10:00 ngày 27/11/2026 giờ VN
const NOW = new Date('2026-11-27T03:00:00Z');
const scope = (permissions = ['smax_chat:view']) =>
  ({
    userId: 9,
    userName: 'Sale B',
    can: (p: string) => permissions.includes(p),
  }) as unknown as AiScope;

const RESULT = {
  versionId: 2,
  coverage: { customerMessages: 100, labeled: 87, pending: 13, ratio: 0.87 },
  counts: {
    byIntent: { complaint: 3 },
    complaint: 3,
    anomaly: 2,
    escalation: 1,
  },
  truncated: false,
  messages: [
    {
      ref: 'p1:t1',
      channel: 'Ms Mai Phương',
      intent: 'complaint',
      intentConfidence: 0.8765,
      text: 'thiếu hàng',
    },
  ],
};

function ctx(labels: jest.Mock | null = jest.fn().mockResolvedValue(RESULT)) {
  return {
    scope: scope(),
    now: NOW,
    deps: {
      smaxChat: {
        myChannels: jest.fn().mockResolvedValue([
          { pagePid: 'p1', name: 'Diệp Trà - Ms Mai Phương' },
          { pagePid: 'p2', name: 'Diệp Trà Mr Nam' },
          { pagePid: 'p3', name: 'Kênh cũ', missing: true },
        ]),
      },
      ...(labels ? { messageIntel: { labelsForChannels: labels } } : {}),
    },
  } as unknown as AiToolContext;
}

describe('smax_message_labels', () => {
  it('chỉ cho người được xem chat Smax', () => {
    expect(smaxMessageLabelsTool.available(scope())).toBe(true);
    expect(smaxMessageLabelsTool.available(scope(['leads:view']))).toBe(false);
  });

  it('chỉ tra trong kênh của người hỏi (lọc theo tên kênh), khoảng ngày giờ VN, bỏ giá trị nhãn không hợp lệ', async () => {
    const labels = jest.fn().mockResolvedValue(RESULT);
    const out = (await smaxMessageLabelsTool.run(ctx(labels), {
      channel: 'mai phuong',
      from: '2026-11-20',
      to: '2026-11-27',
      intent: 'complaint',
      topic: 'bogus',
      flag: 'anomaly',
      limit: 99,
    })) as { messages: object[]; versionId?: number } & Record<string, unknown>;
    const [pagePids, range, filter, limit] = labels.mock.calls[0] as [
      string[],
      { from: Date; to: Date },
      object,
      number,
    ];
    expect(pagePids).toEqual(['p1']);
    expect(range.from.toISOString()).toBe('2026-11-19T17:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-27T17:00:00.000Z');
    expect(filter).toEqual({
      intent: 'complaint',
      topic: undefined,
      sentiment: undefined,
      flag: 'anomaly',
    });
    expect(limit).toBe(30);
    expect(out).toMatchObject({
      enabled: true,
      channels: ['Diệp Trà - Ms Mai Phương'],
      coverage: { ratio: 0.87 },
    });
    expect(out.messages[0]).toMatchObject({
      ref: 'p1:t1',
      intentConfidence: 0.88,
    });
    expect(out.versionId).toBeUndefined();
  });

  it('chưa bật phân loại tin → enabled: false (dùng smax_chats)', async () => {
    expect(await smaxMessageLabelsTool.run(ctx(null), {})).toEqual({
      enabled: false,
    });
    expect(
      await smaxMessageLabelsTool.run(
        ctx(jest.fn().mockResolvedValue(null)),
        {},
      ),
    ).toEqual({ enabled: false });
  });

  it('ngày sai / kênh không có → lỗi rõ ràng', async () => {
    expect(
      await smaxMessageLabelsTool.run(ctx(), { from: '27/11' }),
    ).toMatchObject({
      error: expect.stringContaining('invalid_date') as unknown,
    });
    expect(
      await smaxMessageLabelsTool.run(ctx(), { channel: 'không có' }),
    ).toMatchObject({
      error: 'channel_not_found',
      channels: ['Diệp Trà - Ms Mai Phương', 'Diệp Trà Mr Nam'],
    });
  });
});
