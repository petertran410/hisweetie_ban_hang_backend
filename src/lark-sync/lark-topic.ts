import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * Chuẩn chung cho tin gửi vào NHÓM LARK DẠNG CHỦ ĐỀ (topic) của các luồng duyệt
 * (Bảng giá SP mới, Thay đổi giá…): mỗi phiếu 1 chủ đề, mỗi lần tới bước mới là
 * 1 tin trả lời trong chủ đề, tag người phụ trách bước đó.
 *
 * - Tin mở chủ đề: card "<Loại đề xuất> <mã phiếu>" + thông tin phiếu + nút "Xem phiếu".
 * - Tin trả lời: TIN NHẮN (post, buildTopicReplyPost — người dùng chọn 2026-11-27):
 *     tiêu đề = tiêu đề tin riêng (DM) của bước đó
 *     hàng 1  = tag người phụ trách (tách riêng, không nằm trong câu chữ)
 *     các dòng = "**Người làm** (vai trò) đã …." → "**Lý do:** …" (nếu có) → "Đề nghị …"
 *     hàng cuối = link "Mở phiếu để xử lý" (cần xử lý) / "Xem phiếu" (chỉ để biết)
 * - Tag TẤT CẢ người phụ trách bước mới, kể cả người vừa thao tác (bước mới cũng là
 *   việc của họ). Tin riêng (DM) thì vẫn bỏ người vừa thao tác.
 * - Lưu nguyên TopicDelivery vào `data.group` của sự kiện NOTIFY.
 * Đổi chuẩn ở file này → báo cả các luồng đang dùng (lark-topic.spec.ts bảo vệ chuẩn).
 */

/** Người được tag (open_id null = chưa liên kết Lark → in đậm tên). */
export interface TopicMention {
  name: string;
  openId: string | null;
}

/** Kết quả gửi vào chủ đề — lưu nguyên vào `data.group` của sự kiện NOTIFY. */
export interface TopicDelivery {
  chatId: string;
  /** Tin mở chủ đề (bước sau trả lời vào đây). */
  rootMessageId: string | null;
  /** Tin trả lời vừa gửi. */
  messageId?: string | null;
  /** true = lần này mới mở chủ đề. */
  created: boolean;
  /** Tên người được tag (hiện trong lịch sử phiếu). */
  mentioned: string[];
  status: 'SENT' | 'ERROR';
  error?: string;
}

/** "**Tên** (vai trò)" — người vừa thao tác. */
export function actorText(name?: string | null, role?: string | null): string {
  const n = (name ?? '').trim();
  if (n) return `**${n}**${role ? ` (${role})` : ''}`;
  return role || 'Người xử lý';
}

/** Một phần tử của tin post Lark (chữ / tag / link). */
export type TopicPostNode =
  | { tag: 'text'; text: string; style?: string[] }
  | { tag: 'at'; user_id: string; user_name?: string }
  | { tag: 'a'; text: string; href: string };

/** Nội dung tin post (msg_type 'post'). */
export interface TopicPost {
  zh_cn: { title: string; content: TopicPostNode[][] };
}

/** "Chữ **đậm** chữ" → các phần tử text, phần trong ** ** in đậm. */
function postLine(line: string): TopicPostNode[] {
  return line
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) =>
      /^\*\*[^*]+\*\*$/.test(part)
        ? { tag: 'text' as const, text: part.slice(2, -2), style: ['bold'] }
        : { tag: 'text' as const, text: part },
    );
}

/**
 * Tin trả lời trong chủ đề dạng tin nhắn (post): tiêu đề, hàng tag người phụ trách,
 * các dòng nội dung (hỗ trợ **đậm**), link cuối ("Mở phiếu để xử lý" / "Xem phiếu").
 */
export function buildTopicReplyPost(opts: {
  title: string;
  mentions: TopicMention[];
  lines: string[];
  link: { label: 'Mở phiếu để xử lý' | 'Xem phiếu'; url: string };
}): TopicPost {
  const tags: TopicPostNode[] = opts.mentions.length
    ? opts.mentions.flatMap((m, i): TopicPostNode[] => [
        ...(i ? [{ tag: 'text' as const, text: ' ' }] : []),
        m.openId
          ? { tag: 'at', user_id: m.openId, user_name: m.name }
          : { tag: 'text', text: m.name, style: ['bold'] },
      ])
    : [
        {
          tag: 'text',
          text: '(chưa cấu hình người nhận trong "Cấu hình duyệt")',
        },
      ];
  return {
    zh_cn: {
      title: opts.title,
      content: [
        tags,
        ...opts.lines.filter(Boolean).map(postLine),
        [{ tag: 'a', text: opts.link.label, href: opts.link.url }],
      ],
    },
  };
}

/** Tin mở chủ đề của phiếu, lấy từ các sự kiện NOTIFY cũ (`data.group`). */
export function pickTopicRoot(
  events: { data: unknown }[],
  chatId: string,
): string | null {
  for (const e of events) {
    const g = (e.data as { group?: Partial<TopicDelivery> } | null)?.group;
    if (g?.chatId === chatId && typeof g.rootMessageId === 'string')
      return g.rootMessageId;
  }
  return null;
}

type LarkRes = { code?: number; msg?: string; data?: { message_id?: string } };

/**
 * Chưa có chủ đề → gửi tin mở chủ đề (nhóm dạng chủ đề: mỗi tin mới là 1 chủ đề), rồi
 * trả lời trong chủ đề. Chủ đề cũ hỏng (tin gốc bị xoá…) → mở chủ đề mới, thử lại 1 lần.
 * Không ném lỗi: lỗi trả về trong `status/error` để ghi lịch sử.
 */
export async function postToTopic(
  client: lark.Client | undefined,
  opts: {
    chatId: string;
    existingRootId: string | null;
    rootCard: Record<string, unknown>;
    /** Tin trả lời trong chủ đề (buildTopicReplyPost). */
    replyPost: TopicPost;
    mentioned: string[];
    onRootBroken?: (rootId: string, err: Error) => void;
  },
): Promise<TopicDelivery> {
  const base = { chatId: opts.chatId, mentioned: opts.mentioned };
  if (!client) {
    return {
      ...base,
      rootMessageId: opts.existingRootId,
      created: false,
      status: 'ERROR',
      error: 'Chưa cấu hình Lark',
    };
  }
  const check = (res: LarkRes, what: string) => {
    if (res?.code && res.code !== 0)
      throw new Error(`Lark ${res.code}: ${res.msg || what}`.trim());
  };
  const createTopic = async () => {
    const res = (await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: opts.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(opts.rootCard),
      },
    })) as LarkRes;
    check(res, 'không mở được chủ đề');
    const id = res?.data?.message_id;
    if (!id) throw new Error('Lark không trả về message_id của chủ đề');
    return id;
  };
  const reply = async (rootId: string) => {
    const res = (await client.im.message.reply({
      path: { message_id: rootId },
      data: {
        msg_type: 'post',
        content: JSON.stringify(opts.replyPost),
        reply_in_thread: true,
      },
    })) as LarkRes;
    check(res, '');
    return res?.data?.message_id ?? null;
  };

  let rootId = opts.existingRootId;
  let created = false;
  try {
    if (!rootId) {
      rootId = await createTopic();
      created = true;
    }
    let messageId: string | null;
    try {
      messageId = await reply(rootId);
    } catch (err) {
      if (created) throw err;
      opts.onRootBroken?.(rootId, err as Error);
      rootId = await createTopic();
      created = true;
      messageId = await reply(rootId);
    }
    return {
      ...base,
      rootMessageId: rootId,
      messageId,
      created,
      status: 'SENT',
    };
  } catch (err) {
    return {
      ...base,
      rootMessageId: rootId,
      created,
      status: 'ERROR',
      error: String((err as Error)?.message || err).slice(0, 300),
    };
  }
}
