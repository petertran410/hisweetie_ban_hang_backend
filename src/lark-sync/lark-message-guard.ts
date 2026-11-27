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

/**
 * Bỏ tag (@) những người không có trong danh sách — gửi vào nhóm ở local không được
 * làm phiền người khác. Tag bị bỏ thành chữ "@Tên" (không gửi thông báo).
 */
export function stripMentions(
  msgType: string | undefined,
  content: string | undefined,
  allow: Set<string>,
): string | undefined {
  if (!content) return content;
  if (msgType === 'post') {
    try {
      const post = JSON.parse(content) as Record<string, any>;
      for (const locale of Object.values(post)) {
        if (!Array.isArray(locale?.content)) continue;
        locale.content = locale.content.map((line: any[]) =>
          Array.isArray(line)
            ? line.map((node) =>
                node?.tag === 'at' && !allow.has(String(node.user_id))
                  ? { tag: 'text', text: `@${node.user_name ?? 'người nhận'}` }
                  : node,
              )
            : line,
        );
      }
      return JSON.stringify(post);
    } catch {
      return content;
    }
  }
  // text: <at user_id="ou_x">Tên</at> · card: <at id=ou_x></at>
  return content
    .replace(
      /<at user_id=\\?"([^"\\]*)\\?">([^<]*)<\/at>/g,
      (m, id: string, name: string) => (allow.has(id) ? m : `@${name}`),
    )
    .replace(/<at id=\\?"?([\w-]+)\\?"?><\/at>/g, (m, id: string) =>
      allow.has(id) ? m : '@người nhận',
    );
}

type SendFn = (payload?: any, ...rest: any[]) => Promise<any>;

/**
 * Môi trường local/dev: chỉ cho gửi tin Lark tới người/nhóm trong danh sách.
 * Chặn ngay ở client nên mọi module gửi tin (đơn hàng, công nợ, bảng giá…) đều bị giới hạn.
 * - create: người/nhóm nhận phải nằm trong danh sách.
 * - reply (trả lời / trả lời trong chủ đề): tin gốc phải thuộc nhóm trong danh sách.
 * - Gửi vào nhóm: tag người ngoài danh sách bị bỏ (xem stripMentions).
 */
export function guardLarkMessages(
  client: lark.Client,
  allow: Set<string>,
  logger = new Logger('LarkMessageGuard'),
): void {
  const im = client.im as unknown as {
    message?: Record<string, SendFn>;
    v1?: { message?: Record<string, SendFn> };
  };
  // Lấy bản gốc trước khi bọc: tra nhóm của tin gốc khi trả lời
  const getOriginal = im.message?.get ?? im.v1?.message?.get;
  const getFn = getOriginal?.bind(
    im.message?.get ? im.message : im.v1?.message,
  );
  const chatOfMessage = new Map<string, string | null>();
  const chatOf = async (messageId: string): Promise<string | null> => {
    if (chatOfMessage.has(messageId)) return chatOfMessage.get(messageId)!;
    let chatId: string | null = null;
    try {
      const res = await getFn?.({ path: { message_id: messageId } });
      chatId = res?.data?.items?.[0]?.chat_id ?? null;
    } catch {
      chatId = null;
    }
    chatOfMessage.set(messageId, chatId);
    return chatId;
  };

  const blocked = (name: string, target: string) => {
    logger.warn(
      `Chặn tin Lark (${name}) tới ${target} — không có trong LARK_MESSAGE_ALLOWLIST`,
    );
    return {
      code: LARK_GUARD_BLOCKED_CODE,
      msg: 'Chặn ở môi trường này: người nhận không có trong LARK_MESSAGE_ALLOWLIST',
    };
  };

  const sanitized = (payload: any) => ({
    ...payload,
    data: {
      ...payload.data,
      content: stripMentions(
        payload.data?.msg_type,
        payload.data?.content,
        allow,
      ),
    },
  });

  const wrap = (target: Record<string, SendFn> | undefined, name: string) => {
    const original = target?.[name];
    if (!target || typeof original !== 'function') return;
    target[name] = async (payload?: any, ...rest: any[]) => {
      if (name === 'create') {
        const receiveId: string | undefined = payload?.data?.receive_id;
        if (!receiveId || !allow.has(receiveId))
          return blocked(name, receiveId ?? '?');
        return original.call(target, sanitized(payload), ...rest);
      }
      const messageId: string | undefined = payload?.path?.message_id;
      const chatId = messageId ? await chatOf(messageId) : null;
      if (!chatId || !allow.has(chatId))
        return blocked(name, `${messageId ?? '?'} (nhóm ${chatId ?? '?'})`);
      return original.call(target, sanitized(payload), ...rest);
    };
  };
  for (const target of [im.message, im.v1?.message]) {
    wrap(target, 'create');
    wrap(target, 'reply');
  }
  logger.warn(
    `LARK_MESSAGE_ALLOWLIST đang bật: chỉ gửi tin Lark tới ${allow.size} người/nhóm`,
  );
}
