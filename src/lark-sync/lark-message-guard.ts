import { Logger } from '@nestjs/common';
import type * as lark from '@larksuiteoapi/node-sdk';

/** Mã trả về khi tin bị chặn (không phải mã của Lark). */
export const LARK_GUARD_BLOCKED_CODE = -1001;

/**
 * Đọc LARK_MESSAGE_ALLOWLIST (open_id / chat_id, cách nhau bởi dấu phẩy).
 * Trống hoặc không khai báo → null = không chặn (production).
 */
export function parseLarkAllowlist(raw?: string | null): Set<string> | null {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

type SendFn = (payload?: any, ...rest: any[]) => Promise<any>;

/**
 * Môi trường local/dev: chỉ cho gửi tin Lark tới người/nhóm trong danh sách.
 * Chặn ngay ở client nên mọi module gửi tin (đơn hàng, công nợ, bảng giá…) đều bị giới hạn.
 */
export function guardLarkMessages(
  client: lark.Client,
  allow: Set<string>,
  logger = new Logger('LarkMessageGuard'),
): void {
  const wrap = (target: Record<string, SendFn> | undefined, name: string) => {
    const original = target?.[name];
    if (!target || typeof original !== 'function') return;
    target[name] = async (payload?: any, ...rest: any[]) => {
      // create: data.receive_id; reply: path.message_id (trả lời trong chat sẵn có)
      const receiveId: string | undefined = payload?.data?.receive_id;
      if (name === 'create' && receiveId && allow.has(receiveId)) {
        return original.call(target, payload, ...rest);
      }
      logger.warn(
        `Chặn tin Lark (${name}) tới ${receiveId ?? payload?.path?.message_id ?? '?'} — không có trong LARK_MESSAGE_ALLOWLIST`,
      );
      return {
        code: LARK_GUARD_BLOCKED_CODE,
        msg: 'Chặn ở môi trường này: người nhận không có trong LARK_MESSAGE_ALLOWLIST',
      };
    };
  };
  const im = client.im as unknown as {
    message?: Record<string, SendFn>;
    v1?: { message?: Record<string, SendFn> };
  };
  for (const target of [im.message, im.v1?.message]) {
    wrap(target, 'create');
    wrap(target, 'reply');
  }
  logger.warn(
    `LARK_MESSAGE_ALLOWLIST đang bật: chỉ gửi tin Lark tới ${allow.size} người/nhóm`,
  );
}
