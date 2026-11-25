import type Anthropic from '@anthropic-ai/sdk';
import {
  createAnthropicChatClient,
  toAnthropicMessages,
} from './anthropic-chat-client';
import { toOpenAiMessages, type ChatMessage } from './openai-chat-client';

const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: 'rules', cache: true },
  { role: 'system', content: 'session' },
  { role: 'user', content: 'Câu 1' },
  { role: 'assistant', content: 'Đáp 1' },
  { role: 'user', content: 'Câu 2', cache: true, context: '[ngữ cảnh]' },
];

describe('toAnthropicMessages: điểm cache', () => {
  it('điểm cache trên system cố định và ngay sau chữ câu hỏi; ngữ cảnh đứng sau', () => {
    const { system, messages } = toAnthropicMessages(CONVERSATION);
    expect(system).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'session' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Câu 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Đáp 1' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Câu 2', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '[ngữ cảnh]' },
        ],
      },
    ]);
  });

  it('TTL 1h chỉ áp cho system (mục 1h phải đứng trước mục 5m)', () => {
    const { system, messages } = toAnthropicMessages(CONVERSATION, {
      cacheTtl: '1h',
    });
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const question = messages[2]
      .content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(question[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('lời dặn sau kết quả công cụ nằm chung tin với tool_result, đứng sau chúng', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'Doanh thu?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'revenue', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"total":1}' },
      { role: 'user', content: 'Trả lời ngay.' },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"total":1}' },
        { type: 'text', text: 'Trả lời ngay.' },
      ],
    });
  });
});

describe('createAnthropicChatClient: cache', () => {
  it('gửi system dạng khối có điểm cache, tự đặt điểm cuối, tách token đọc / ghi cache', async () => {
    let sent: Anthropic.Beta.Messages.MessageCreateParamsStreaming | null =
      null;
    const client = createAnthropicChatClient({
      apiKey: 'test',
      effort: 'medium',
      cacheTtl: '1h',
      stream: (params) => {
        sent = params;
        return {
          on: () => undefined,
          finalMessage: () =>
            Promise.resolve({
              model: 'claude-sonnet-5-5',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }],
              usage: {
                input_tokens: 20,
                cache_read_input_tokens: 7000,
                cache_creation_input_tokens: 300,
                output_tokens: 50,
              },
            } as unknown as Anthropic.Beta.Messages.BetaMessage),
        };
      },
    });
    const result = await client.complete({
      model: 'claude-sonnet-5-5',
      messages: CONVERSATION,
    });
    expect(sent!.system).toEqual([
      {
        type: 'text',
        text: 'rules',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'text', text: 'session' },
    ]);
    expect(sent!.cache_control).toEqual({ type: 'ephemeral' });
    // Tối đa 4 điểm cache: system + câu hỏi + điểm tự động ở cuối = 3.
    const marks = JSON.stringify(sent).match(/"cache_control"/g) ?? [];
    expect(marks.length).toBeLessThanOrEqual(4);
    expect(result.usage).toEqual({
      promptTokens: 7320,
      completionTokens: 50,
      cacheReadTokens: 7000,
      cacheWriteTokens: 300,
    });
  });
});

describe('toOpenAiMessages', () => {
  it('gộp system liền nhau, nối ngữ cảnh sau câu hỏi, bỏ trường riêng của Claude', () => {
    expect(
      toOpenAiMessages([
        ...CONVERSATION.slice(0, 4),
        {
          role: 'assistant',
          content: 'x',
          anthropicContent: [{ type: 'thinking' }],
        },
        CONVERSATION[4],
      ]),
    ).toEqual([
      { role: 'system', content: 'rules\n\nsession' },
      { role: 'user', content: 'Câu 1' },
      { role: 'assistant', content: 'Đáp 1' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'Câu 2\n\n[ngữ cảnh]' },
    ]);
  });
});
