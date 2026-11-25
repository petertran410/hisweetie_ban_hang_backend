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
type TextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
export type CacheTtl = '5m' | '1h';

export type AnthropicChatClientConfig = {
  apiKey: string;
  /** "low" | "medium" | "high": how hard Claude thinks before answering and between lookups. */
  effort: 'low' | 'medium' | 'high';
  /**
   * Lifetime of the cached fixed prefix (tools + system blocks marked `cache`). "1h" costs 2× base
   * input to write instead of 1.25×, reads stay 0.1×: worth it when questions are > 5 min apart.
   */
  cacheTtl?: CacheTtl;
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
 *
 * Prompt caching is a byte-exact prefix match, so every message renders the same way each time it
 * is sent: system messages become system text blocks, user text is always a block array, and a
 * user text that follows tool results joins their message. `cache` marks a breakpoint (1h only
 * for system blocks when asked: a 1h entry must come before 5m ones); `context` goes after it.
 */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  options: { cacheTtl?: CacheTtl } = {},
): {
  system: TextBlockParam[];
  messages: MessageParam[];
} {
  const systemCache: Anthropic.Beta.Messages.BetaCacheControlEphemeral =
    options.cacheTtl === '1h'
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' };
  const system: TextBlockParam[] = [];
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
    if (message.role === 'system') {
      system.push({
        type: 'text',
        text: message.content,
        ...(message.cache ? { cache_control: systemCache } : {}),
      });
      continue;
    }
    const blocks: ContentBlockParam[] = [
      // Ảnh trước chữ (Claude đọc ảnh tốt hơn khi ảnh đứng trước câu hỏi)
      ...(message.images ?? []).map(
        (image): ContentBlockParam => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: image.data,
          },
        }),
      ),
      {
        type: 'text',
        text: message.content,
        ...(message.cache ? { cache_control: { type: 'ephemeral' } } : {}),
      },
      ...(message.context
        ? [{ type: 'text', text: message.context } as ContentBlockParam]
        : []),
    ];
    const last = out.at(-1);
    // Text after tool results (e.g. "answer now") joins their message, after the tool_result blocks.
    if (last?.role === 'user' && Array.isArray(last.content))
      last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  }
  return { system, messages: out };
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
      const { system, messages } = toAnthropicMessages(request.messages, {
        cacheTtl: config.cacheTtl,
      });
      const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model: request.model,
        max_tokens: config.maxTokens ?? 16_000,
        ...(system.length ? { system } : {}),
        messages,
        ...(request.tools?.length
          ? { tools: toTools(request.tools), tool_choice: { type: 'auto' } }
          : {}),
        output_config: { effort: config.effort },
        // Automatic breakpoint on the last block: the next tool round (same prefix + new blocks)
        // reads everything so far from cache. With the `cache` breakpoints that makes at most 3 of 4.
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
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      return {
        content: text,
        toolCalls,
        finishReason: message.stop_reason,
        usage: {
          promptTokens: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
          completionTokens: usage.output_tokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
        model: message.model,
        providerContent: message.content,
      };
    },
  };
}
