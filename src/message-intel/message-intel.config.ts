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

/** Nhóm Lark "Báo cáo hàng ngày Sale Chat" (user chốt); đổi bằng MESSAGE_INTEL_ALERT_CHAT_ID. */
const DEFAULT_ALERT_CHAT_ID = 'oc_92ea2a2bbcca2116111809a3461f5795';

/**
 * Cảnh báo quản lý qua Lark: MESSAGE_INTEL_ALERTS_ENABLED=true mới gửi (mặc định tắt — dev dùng bản sao
 * dữ liệu production không gửi cảnh báo thật).
 */
export const alertsConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  enabled: env.MESSAGE_INTEL_ALERTS_ENABLED === 'true',
  chatId: env.MESSAGE_INTEL_ALERT_CHAT_ID?.trim() || DEFAULT_ALERT_CHAT_ID,
});
