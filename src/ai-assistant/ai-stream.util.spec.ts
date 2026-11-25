import { EventType, type BaseEvent } from '@ag-ui/core';
import { coalesceText } from './ai-stream.util';

const text = (delta: string, messageId = 'm1') =>
  ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }) as BaseEvent;
const other = (type: EventType) => ({ type }) as BaseEvent;
const summary = (events: BaseEvent[]) =>
  events.map((e) =>
    e.type === EventType.TEXT_MESSAGE_CONTENT
      ? `${(e as BaseEvent & { messageId: string }).messageId}:${(e as BaseEvent & { delta: string }).delta}`
      : e.type,
  );

describe('coalesceText', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('mẩu đầu đi ngay, các mẩu trong 50ms gộp thành một lần ghi', () => {
    const out: BaseEvent[] = [];
    const stream = coalesceText((e) => out.push(e), 50);
    stream.push(text('Xin'));
    expect(summary(out)).toEqual(['m1:Xin']);
    stream.push(text(' chào'));
    stream.push(text(' bạn'));
    expect(out).toHaveLength(1);
    jest.advanceTimersByTime(50);
    expect(summary(out)).toEqual(['m1:Xin', 'm1: chào bạn']);
    // Không còn gì để gom: hẹn giờ dừng, mẩu kế tiếp lại đi ngay.
    jest.advanceTimersByTime(50);
    stream.push(text('!'));
    expect(summary(out)).toEqual(['m1:Xin', 'm1: chào bạn', 'm1:!']);
    stream.end();
  });

  it('sự kiện khác xả phần đang gom trước, giữ đúng thứ tự', () => {
    const out: BaseEvent[] = [];
    const stream = coalesceText((e) => out.push(e), 50);
    stream.push(other(EventType.TEXT_MESSAGE_START));
    stream.push(text('Để'));
    stream.push(text(' mình xem.'));
    stream.push(other(EventType.TEXT_MESSAGE_END));
    stream.push(other(EventType.TOOL_CALL_START));
    expect(summary(out)).toEqual([
      'TEXT_MESSAGE_START',
      'm1:Để',
      'm1: mình xem.',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
    ]);
    stream.end();
  });

  it('đổi tin thì không gộp chữ hai tin; end() xả phần còn lại', () => {
    const out: BaseEvent[] = [];
    const stream = coalesceText((e) => out.push(e), 50);
    stream.push(text('A', 'm1'));
    stream.push(text('B', 'm1'));
    stream.push(text('C', 'm2'));
    stream.push(text('D', 'm2'));
    stream.end();
    expect(summary(out)).toEqual(['m1:A', 'm1:B', 'm2:CD']);
    jest.advanceTimersByTime(200);
    expect(out).toHaveLength(3);
  });
});
