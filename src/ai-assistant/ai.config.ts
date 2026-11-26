import type { AnthropicChatClientConfig } from './llm/anthropic-chat-client';
import type { OpenAiChatClientConfig } from './llm/openai-chat-client';

export type AiChatConfig = {
  enabled: boolean;
  configured: boolean;
  /** Model thử lần lượt; một model đã trả lời một vòng thì cả câu hỏi ở lại model đó. */
  assistantModels: string[];
  maxToolRounds: number;
  /** Số công cụ (truy vấn DB) của trợ lý chạy cùng lúc trên toàn hệ thống; còn lại xếp hàng. */
  maxToolConcurrency: number;
  timeoutMs: number;
  /** Số câu mỗi người được hỏi trong 60 phút gần nhất. */
  rateLimitPerHour: number;
  retentionDays: number;
  /** Số tin cũ của hội thoại gửi kèm câu hỏi mới. */
  historyMessages: number;
};

const int = (value: string | undefined, fallback: number) => {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (value: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

/**
 * Cấu hình trợ lý từ biến môi trường (giống Sweetie-HRM):
 * - AI_CHAT_ENABLED=true bật trợ lý.
 * - ANTHROPIC_API_KEY → Claude (AI_CLAUDE_MODEL, mặc định claude-haiku-5-5; AI_CLAUDE_EFFORT
 *   low|medium|high, mặc định medium) trả lời trước. AI_CLAUDE_CACHE_TTL 5m|1h (mặc định 5m):
 *   thời gian giữ cache phần cố định (công cụ + quy tắc); 1h ghi đắt hơn (2× thay vì 1,25×) nhưng
 *   không mất cache khi hai câu hỏi cách nhau quá 5 phút.
 * - AI_API_KEY + AI_BASE_URL → cổng OpenAI-compatible (9Router): AI_MODEL rồi AI_MODEL_FALLBACK
 *   dự phòng khi Claude lỗi. AI_DISABLE_THINKING (mặc định true) tắt suy nghĩ của model cổng.
 * - AI_MAX_TOOL_ROUNDS (6), AI_TIMEOUT_MS (300000), AI_RATE_LIMIT_PER_HOUR (50),
 *   AI_CHAT_RETENTION_DAYS (90), AI_HISTORY_MESSAGES (12).
 * - AI_MAX_TOOL_CONCURRENCY (1, tối đa 5): số lượt tra cứu của trợ lý chạy cùng lúc trên cả hệ
 *   thống, để trợ lý không chiếm pool kết nối DB mà màn hình bán hàng đang dùng (một lượt tra
 *   doanh thu đã là ~11 truy vấn song song, như mở trang Dashboard).
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): {
  chat: AiChatConfig;
  client: OpenAiChatClientConfig | null;
  claude: AnthropicChatClientConfig | null;
} {
  const apiKey = env.AI_API_KEY?.trim() ?? '';
  const claudeKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const model = env.AI_MODEL?.trim() || 'ocg/deepseek-v4.1-flash';
  const fallbackModel = env.AI_MODEL_FALLBACK?.trim() || null;
  const gatewayModels = apiKey
    ? [model, ...(fallbackModel ? [fallbackModel] : [])]
    : [];
  const claudeModel = env.AI_CLAUDE_MODEL?.trim() || 'claude-haiku-5-5';
  const effortRaw = env.AI_CLAUDE_EFFORT?.trim();
  const effort: AnthropicChatClientConfig['effort'] =
    effortRaw === 'low' || effortRaw === 'high' ? effortRaw : 'medium';
  const cacheTtl: AnthropicChatClientConfig['cacheTtl'] =
    env.AI_CLAUDE_CACHE_TTL?.trim() === '1h' ? '1h' : '5m';
  return {
    chat: {
      enabled: bool(env.AI_CHAT_ENABLED),
      configured: Boolean(apiKey || claudeKey),
      assistantModels: claudeKey
        ? [claudeModel, ...gatewayModels]
        : gatewayModels,
      maxToolRounds: Math.min(int(env.AI_MAX_TOOL_ROUNDS, 6), 8),
      maxToolConcurrency: Math.min(int(env.AI_MAX_TOOL_CONCURRENCY, 1), 5),
      timeoutMs: int(env.AI_TIMEOUT_MS, 300_000),
      rateLimitPerHour: int(env.AI_RATE_LIMIT_PER_HOUR, 50),
      retentionDays: int(env.AI_CHAT_RETENTION_DAYS, 90),
      historyMessages: int(env.AI_HISTORY_MESSAGES, 12),
    },
    client: apiKey
      ? {
          baseUrl:
            env.AI_BASE_URL?.trim() ||
            'https://9router.hisweetievietnam.com/v1',
          apiKey,
          // Mặc định tắt suy nghĩ của model cổng (như HRM); AI_DISABLE_THINKING=false để bật.
          disableThinking: env.AI_DISABLE_THINKING?.trim()
            ? bool(env.AI_DISABLE_THINKING)
            : true,
        }
      : null,
    claude: claudeKey ? { apiKey: claudeKey, effort, cacheTtl } : null,
  };
}
