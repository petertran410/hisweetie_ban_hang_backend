const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/**
 * Cấu hình worker Message Intelligence (env, đọc mỗi lượt để đổi không cần build lại):
 * - MESSAGE_INTEL_ENABLED=true: bật quét tin mới + phân loại (mặc định tắt)
 * - MESSAGE_INTEL_DRY_RUN=true: chỉ quét + dựng ngữ cảnh, ước tính token, không gọi Jev
 * - MESSAGE_INTEL_PAGE_PIDS: chỉ các kênh này (rollout từng kênh); rỗng = mọi kênh
 * - MESSAGE_INTEL_CONCURRENCY (mặc định 4), MESSAGE_INTEL_BATCH (mặc định 20 tin / lượt 15 giây)
 */
export function intelConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.MESSAGE_INTEL_ENABLED === 'true',
    dryRun: env.MESSAGE_INTEL_DRY_RUN === 'true',
    concurrency: clamp(Number(env.MESSAGE_INTEL_CONCURRENCY) || 4, 1, 16),
    batch: clamp(Number(env.MESSAGE_INTEL_BATCH) || 20, 1, 100),
    pagePids: (env.MESSAGE_INTEL_PAGE_PIDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Ngày theo giờ VN (YYYY-MM-DD) cho ngân sách token. */
export const vnDay = (d = new Date()) =>
  new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Nhóm Lark "Báo cáo hàng ngày Sale Chat" (user chốt) — dùng khi chưa đặt chat id trên màn hình. */
export const DEFAULT_ALERT_CHAT_ID = 'oc_92ea2a2bbcca2116111809a3461f5795';

/** Chat id nhóm Lark (dạng oc_…). */
export const LARK_CHAT_ID = /^oc_[A-Za-z0-9]{10,64}$/;

/**
 * Cảnh báo quản lý qua Lark: bật / tắt và nhóm nhận đặt trên màn hình Phân tích tin nhắn (lưu trong
 * smax_intel_runtime). Bản sao DB cho dev tự tắt cảnh báo (scripts/dev-db/sync-prod-to-local.sh).
 */
export const alertSettings = (runtime: {
  alertsEnabled: boolean;
  alertChatId: string | null;
}) => ({
  enabled: runtime.alertsEnabled,
  chatId: runtime.alertChatId || DEFAULT_ALERT_CHAT_ID,
  defaultChat: !runtime.alertChatId,
});
