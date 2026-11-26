import * as compression from 'compression';
import { EventType, type BaseEvent } from '@ag-ui/core';

export const AI_AGENT_PATH = '/api/ai/agent';

/** Khoảng gom chữ: mỗi tin nhắn ghi xuống mạng nhiều nhất 1 lần mỗi chừng này ms. */
export const TEXT_FLUSH_MS = 50;

type TextContent = BaseEvent & { messageId: string; delta: string };

/**
 * Gom các mẩu chữ (TEXT_MESSAGE_CONTENT) liền nhau của cùng một tin thành một sự kiện mỗi
 * `windowMs`: model gửi hàng trăm mẩu vài chữ, mỗi mẩu là một lần ghi socket qua nginx và một lần
 * trình duyệt vẽ lại markdown. Mẩu đầu đi ngay (chữ hiện không trễ); sự kiện khác (công cụ, kết
 * thúc…) xả phần đang gom trước, nên thứ tự sự kiện không đổi.
 */
export function coalesceText(
  emit: (event: BaseEvent) => void,
  windowMs = TEXT_FLUSH_MS,
) {
  let buffer: TextContent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (buffer) emit(buffer);
    buffer = null;
  };
  const tick = () => {
    timer = null;
    if (!buffer) return;
    flush();
    timer = setTimeout(tick, windowMs);
  };
  return {
    push(event: BaseEvent) {
      if (event.type !== EventType.TEXT_MESSAGE_CONTENT) {
        flush();
        emit(event);
        return;
      }
      const text = event as TextContent;
      if (buffer && buffer.messageId !== text.messageId) flush();
      if (!timer) {
        emit(text);
        timer = setTimeout(tick, windowMs);
      } else if (buffer)
        buffer = { ...buffer, delta: buffer.delta + text.delta };
      else buffer = { ...text };
    },
    /** Xả phần còn lại và dừng hẹn giờ (gọi trước khi đóng response). */
    end() {
      if (timer) clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}

type FilterArgs = Parameters<typeof compression.filter>;

/** Bộ lọc `compression()`: không nén stream trợ lý AI (SSE) — nén sẽ dồn sự kiện lại. */
export function compressUnlessAiStream(
  req: FilterArgs[0],
  res: FilterArgs[1],
): boolean {
  return (
    !req.originalUrl?.startsWith(AI_AGENT_PATH) && compression.filter(req, res)
  );
}
