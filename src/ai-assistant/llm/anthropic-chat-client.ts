import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type ChatMessage,
  type LlmClient,
  type ToolCall,
  type ToolDefinition,
} from './openai-chat-client';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

export type AnthropicChatClientConfig = {
  apiKey: string;
  /** "low" | "medium" | "high": how hard Claude thinks before answering and between lookups. */
  effort: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** For tests: a stand-in for the SDK's `beta.messages.stream`. */
  stream?: (
    params: Anthropic.Beta.Messages.MessageCreateParamsStreaming,
    options: { signal?: AbortSignal },
  ) => {
    on(event: 'text', listener: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage>;
  };
};

/** Server-side fallback on a refusal: the API re-runs the request on a model it picks, in the same call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The assistant's conversation (OpenAI chat shape, shared with the gateway client) as a Messages
 * API request. An assistant turn that came from Claude carries its original content blocks
 * (`anthropicContent`, thinking blocks included) and goes back verbatim; tool results of one turn
 * go back together in a single user message.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string;
  messages: MessageParam[];
} {
  const system: string[] = [];
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const result: ContentBlockParam = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      const last = out.at(-1);
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((block) => block.type === 'tool_result')
      )
        last.content.push(result);
      else out.push({ role: 'user', content: [result] });
      continue;
    }
    if (message.role === 'assistant') {
      if (Array.isArray(message.anthropicContent)) {
        out.push({
          role: 'assistant',
          content: message.anthropicContent as ContentBlockParam[],
        });
        continue;
      }
      const content: ContentBlockParam[] = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? [])
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      out.push({
        role: 'assistant',
        content: content.length ? content : (message.content ?? ''),
      });
      continue;
    }
    if (message.role === 'system') system.push(message.content);
    else out.push({ role: 'user', content: message.content });
  }
  return { system: system.join('\n\n'), messages: out };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = raw.trim() ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toTools(
  tools: readonly ToolDefinition[],
): Anthropic.Beta.Messages.BetaTool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function
      .parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
  }));
}

/**
 * Claude through the Anthropic Messages API, behind the assistant's `LlmClient`: answer text
 * streams through `onText`, tool calls come back in the shared shape. API failures become
 * `LlmError` so the assistant can move on to its fallback model; a cancelled request is rethrown as is.
 */
export function createAnthropicChatClient(
  config: AnthropicChatClientConfig,
): LlmClient {
  const client = config.stream
    ? null
    : new Anthropic({ apiKey: config.apiKey, maxRetries: 1 });
  const stream =
    config.stream ??
    ((params, options) => client!.beta.messages.stream(params, options));

  return {
    async complete(request) {
      const { system, messages } = toAnthropicMessages(request.messages);
      const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model: request.model,
        max_tokens: config.maxTokens ?? 16_000,
        system,
        messages,
        ...(request.tools?.length
          ? { tools: toTools(request.tools), tool_choice: { type: 'auto' } }
          : {}),
        output_config: { effort: config.effort },
        // The system prompt and tools repeat on every round and every question: read them from cache.
        cache_control: { type: 'ephemeral' },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        stream: true,
      };
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        const running = stream(
          params,
          request.signal ? { signal: request.signal } : {},
        );
        running.on('text', (delta) => request.onText?.(delta));
        message = await running.finalMessage();
      } catch (error) {
        if (
          request.signal?.aborted ||
          error instanceof Anthropic.APIUserAbortError
        )
          throw error;
        if (error instanceof Anthropic.APIError)
          throw new LlmError(
            `anthropic_http_${error.status ?? 'error'}: ${error.message.slice(0, 200)}`,
            error.status ?? null,
          );
        throw new LlmError(
          `anthropic_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          null,
        );
      }
      // The whole fallback chain declined: let the assistant try its own fallback model.
      if (message.stop_reason === 'refusal')
        throw new LlmError('anthropic_refusal', null);

      const text = message.content
        .filter(
          (block): block is Anthropic.Beta.Messages.BetaTextBlock =>
            block.type === 'text',
        )
        .map((block) => block.text)
        .join('');
      const toolCalls: ToolCall[] = message.content
        .filter(
          (block): block is Anthropic.Beta.Messages.BetaToolUseBlock =>
            block.type === 'tool_use',
        )
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      const usage = message.usage;
      return {
        content: text,
        toolCalls,
        finishReason: message.stop_reason,
        usage: {
          promptTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          completionTokens: usage.output_tokens ?? 0,
        },
        model: message.model,
        providerContent: message.content,
      };
    },
  };
}
