import { toAnthropicMessages } from './anthropic-chat-client';

describe('toAnthropicMessages: ảnh', () => {
  it('tin user có ảnh → khối image (base64) trước khối text', () => {
    const { messages } = toAnthropicMessages([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: 'Đọc ảnh',
        images: [{ mediaType: 'image/png', data: 'AAAA' }],
      },
    ]);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
          { type: 'text', text: 'Đọc ảnh' },
        ],
      },
    ]);
  });
});
