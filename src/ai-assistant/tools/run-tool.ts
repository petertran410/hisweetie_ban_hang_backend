import { Logger } from '@nestjs/common';
import type { ToolDefinition } from '../llm/openai-chat-client';
import type { AiScope, AiTool, AiToolContext } from './common';

/** Kết quả công cụ gửi cho model tối đa chừng này ký tự (trình duyệt không nhận kết quả). */
export const MAX_RESULT_CHARS = 12_000;

const logger = new Logger('AiTools');

export function availableTools(
  tools: readonly AiTool[],
  scope: AiScope,
): AiTool[] {
  return tools.filter((tool) => tool.available(scope));
}

export function toolDefinitions(
  tools: readonly AiTool[],
  scope: AiScope,
): ToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description:
        typeof tool.description === 'function'
          ? tool.description(scope)
          : tool.description,
      parameters:
        typeof tool.parameters === 'function'
          ? tool.parameters(scope)
          : tool.parameters,
    },
  }));
}

/** Chạy một lượt gọi công cụ. Công cụ lạ / không có quyền / tham số hỏng → lỗi model đọc được. */
export async function runTool(
  context: AiToolContext,
  tools: readonly AiTool[],
  name: string,
  rawArguments: string,
): Promise<{ ok: boolean; content: string }> {
  const tool = tools.find((item) => item.name === name);
  if (!tool || !tool.available(context.scope))
    return {
      ok: false,
      content: JSON.stringify({ error: 'tool_not_allowed' }),
    };
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      args = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      content: JSON.stringify({ error: 'invalid_arguments' }),
    };
  }
  try {
    const result = await tool.run(context, args);
    const text = JSON.stringify(result ?? null);
    const ok = !(
      result &&
      typeof result === 'object' &&
      'error' in (result as Record<string, unknown>)
    );
    return {
      ok,
      content:
        text.length > MAX_RESULT_CHARS
          ? `${text.slice(0, MAX_RESULT_CHARS)}… (đã cắt bớt)`
          : text,
    };
  } catch (error) {
    logger.error(
      `Công cụ ${name} lỗi: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, content: JSON.stringify({ error: 'tool_failed' }) };
  }
}
