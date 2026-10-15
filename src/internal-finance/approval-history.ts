// Lịch sử duyệt của đơn Lark (timeline trong detailSnapshot) để hiện trên POS:
// chỉ loại thao tác, thời điểm, nhận xét và người làm; không lộ mã đơn / ID Lark.

export type ApprovalHistoryItem = {
  type: string;
  time: string | null;
  comment: string | null;
  /** open_id người làm; service đổi sang tên rồi bỏ đi trước khi trả về. */
  openId: string | null;
};

/** Đơn Lark kết thúc mà không duyệt: lý do nằm ở bước cuối loại này. */
export const ENDED_TIMELINE_TYPES = ['REJECT', 'CANCEL', 'DELETE'];

const asText = (value: unknown) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

export function approvalHistory(
  detailSnapshot: unknown,
): ApprovalHistoryItem[] {
  const timeline = (detailSnapshot as { timeline?: unknown } | null)?.timeline;
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((item) => item && typeof item === 'object')
    .map((item: any) => {
      const ms = Number(item.create_time);
      return {
        type: String(item.type || ''),
        time: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
        comment: asText(item.comment),
        openId: asText(item.open_id) || asText(item.user_id),
      };
    })
    .filter((item) => item.type);
}

/** Bước làm đơn kết thúc không duyệt (từ chối / thu hồi / xóa), mới nhất. */
export function endingStep(history: ApprovalHistoryItem[]) {
  return (
    [...history]
      .reverse()
      .find((item) => ENDED_TIMELINE_TYPES.includes(item.type)) || null
  );
}
