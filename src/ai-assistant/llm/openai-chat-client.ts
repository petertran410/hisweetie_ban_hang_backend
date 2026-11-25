/**
 * Minimal streaming client for OpenAI-compatible `/chat/completions` endpoints (9Router).
 * Only `delta.content` and `delta.tool_calls` are read: reasoning models (DeepSeek format)
 * also stream `reasoning_content`, which is never shown nor stored.
 */

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** Ảnh gửi kèm tin user (base64, không có tiền tố data:). */
export type ChatImage = { mediaType: string; data: string };

/**
 * `cache` (Claude only): put a prompt-cache breakpoint right after this system block / this
 * user text, so a later request that starts with the same bytes reads it from cache.
 * `context` (user only): per-request facts (open page, chat customer) sent right after the
 * question — after its breakpoint and never stored, so history replays stay byte-identical.
 */
export type ChatMessage =
  | { role: 'system'; content: string; cache?: boolean }
  | {
      role: 'user';
      content: string;
      images?: ChatImage[];
      context?: string;
      cache?: boolean;
    }
  /** `anthropicContent`: Claude's original content blocks of this turn, sent back as is to Claude only. */
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      anthropicContent?: unknown;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type CompletionUsage = {
  /** Every input token, cached or not. */
  promptTokens: number;
  completionTokens: number;
  /** Claude: input tokens read from cache (0.1× price) and written to it — both already in promptTokens. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type CompletionResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: CompletionUsage | null;
  model: string;
  /** The provider's own content blocks, when the next round must get them back verbatim (Claude's thinking). */
  providerContent?: unknown;
};

export type CompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Called with each piece of answer text as it arrives. */
  onText?: (delta: string) => void;
};

export interface LlmClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type OpenAiChatClientConfig = {
  baseUrl: string;
  apiKey: string;
  /** Sends `thinking: { type: "disabled" }` so reasoning models answer and call tools directly. */
  disableThinking?: boolean;
  fetchImpl?: typeof fetch;
};

type StreamChunk = {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

function usageOf(chunk: StreamChunk): CompletionUsage | null {
  return chunk.usage
    ? {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      }
    : null;
}

/**
 * The shared conversation in OpenAI chat shape: Claude-only fields dropped (`anthropicContent`,
 * `cache`), adjacent system messages joined into one, a user message's `context` appended to
 * its text, images as `image_url` data URIs.
 */
export function toOpenAiMessages(
  messages: readonly ChatMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const last = out.at(-1);
      if (last?.role === 'system')
        last.content = `${String(last.content)}\n\n${message.content}`;
      else out.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      const text = message.context
        ? `${message.content}\n\n${message.context}`
        : message.content;
      out.push(
        message.images?.length
          ? {
              role: 'user',
              content: [
                ...message.images.map((image) => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${image.mediaType};base64,${image.data}`,
                  },
                })),
                { type: 'text', text },
              ],
            }
          : { role: 'user', content: text },
      );
    } else if (message.role === 'assistant') {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { anthropicContent: _omit, ...rest } = message;
      out.push(rest);
    } else out.push(message);
  }
  return out;
}

export function createOpenAiChatClient(
  config: OpenAiChatClientConfig,
): LlmClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async complete(request) {
      const body = {
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        ...(request.tools?.length
          ? { tools: request.tools, tool_choice: 'auto' }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        ...(config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      };
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new LlmError(
          `llm_unreachable: ${error instanceof Error ? error.message : String(error)}`,
          null,
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new LlmError(
          `llm_http_${response.status}: ${detail}`,
          response.status,
        );
      }

      const result: CompletionResult = {
        content: '',
        toolCalls: [],
        finishReason: null,
        usage: null,
        model: request.model,
      };
      const calls = new Map<number, ToolCall>();
      const apply = (chunk: StreamChunk) => {
        if (chunk.model) result.model = chunk.model;
        result.usage = usageOf(chunk) ?? result.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) result.finishReason = choice.finish_reason;
        // Non-streamed answer (some gateways ignore `stream: true`).
        if (choice.message) {
          if (choice.message.content) {
            result.content += choice.message.content;
            request.onText?.(choice.message.content);
          }
          choice.message.tool_calls?.forEach((call, index) =>
            calls.set(index, call),
          );
          return;
        }
        const delta = choice.delta;
        if (!delta) return;
        if (delta.content) {
          result.content += delta.content;
          request.onText?.(delta.content);
        }
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? 0;
          const call = calls.get(index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments)
            call.function.arguments += part.function.arguments;
          calls.set(index, call);
        }
      };

      if (
        !(response.headers.get('content-type') ?? '').includes(
          'text/event-stream',
        )
      ) {
        apply((await response.json()) as StreamChunk);
      } else if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        while (!done) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              done = true;
              break;
            }
            try {
              apply(JSON.parse(data) as StreamChunk);
            } catch {
              /* keep-alive or partial noise */
            }
          }
        }
        if (done) await reader.cancel().catch(() => {});
      }

      result.toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
        .filter((call) => call.function.name);
      return result;
    },
  };
}
