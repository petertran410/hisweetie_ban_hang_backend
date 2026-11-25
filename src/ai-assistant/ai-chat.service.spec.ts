import {
  AiChatService,
  AUDIT_ASK,
  AUDIT_TOOL,
  systemPrompt,
} from './ai-chat.service';
import type { AiChatConfig } from './ai.config';
import type { AiScope } from './ai-scope';
import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type LlmClient,
} from './llm/openai-chat-client';
import type { AiTool } from './tools/common';
import { MAX_RESULT_CHARS, runTool } from './tools/run-tool';
import { forwardedContext, lastUserText } from './ai-assistant.controller';

const CONFIG: AiChatConfig = {
  enabled: true,
  configured: true,
  assistantModels: ['claude-sonnet-5-5', 'ocg/deepseek-v4.1-flash'],
  maxToolRounds: 5,
  timeoutMs: 10_000,
  rateLimitPerDay: 100,
  retentionDays: 90,
  historyMessages: 12,
};
const NOW = new Date('2026-11-22T03:00:00.000Z');

const scopeOf = (perms: string[], canViewOther = true): AiScope => ({
  userId: 7,
  userName: 'Sale A',
  can: (p) => perms.includes(p),
  user: {
    id: 7,
    name: 'Sale A',
    canViewOtherStaffData: canViewOther,
    branchId: 1,
    branchIds: [1],
    roles: [],
  },
  branchId: null,
  leadActor: {
    id: 7,
    name: 'Sale A',
    ownOnly: !perms.includes('leads:update'),
  },
  quoteActor: { id: 7, name: 'Sale A', ownOnly: true },
});

const invoiceTool: AiTool = {
  name: 'invoices_summary',
  label: 'Đang tra cứu hoá đơn',
  description: 'Tổng hợp hoá đơn',
  parameters: { type: 'object', properties: {} },
  available: (scope) => scope.can('invoices:view'),
  run: jest.fn(async () => ({ total: 3, revenue: 12_500_000 })),
};

type Row = Record<string, any>;

/** Bản giả trong bộ nhớ cho các bảng mà service đụng tới. */
function fakeStore(
  opts: { asked?: number; conversations?: Row[]; messages?: Row[] } = {},
) {
  const conversations: Row[] = [...(opts.conversations ?? [])];
  const messages: Row[] = [...(opts.messages ?? [])];
  const audits: Row[] = [];
  let seq = 100;
  const prisma = {
    auditLog: { count: jest.fn(async () => opts.asked ?? 0) },
    branch: { findUnique: jest.fn(async () => null) },
    customer: {
      findUnique: jest.fn(async () => ({ code: 'KH000123', name: 'Quán A' })),
    },
    aiChatConversation: {
      findFirst: jest.fn(
        async ({ where }: Row) =>
          conversations.find(
            (r) => r.id === where.id && r.userId === where.userId,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: Row) => {
        const row = { id: ++seq, ...data };
        conversations.push(row);
        return { id: row.id, title: row.title };
      }),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 2 })),
    },
    aiChatMessage: {
      findMany: jest.fn(async ({ where }: Row) =>
        messages
          .filter((r) => r.conversationId === where.conversationId)
          .slice()
          .reverse(),
      ),
      create: jest.fn(async ({ data }: Row) => {
        const row = { id: ++seq, ...data };
        messages.push(row);
        return row;
      }),
      deleteMany: jest.fn(async () => ({ count: 5 })),
    },
  };
  const audit = {
    create: jest.fn(async (data: Row) => {
      audits.push(data);
      return data;
    }),
  };
  return { prisma, audit, conversations, messages, audits };
}

function scriptedLlm(
  script: Array<
    (r: CompletionRequest) => CompletionResult | Promise<CompletionResult>
  >,
): LlmClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push({ ...request, messages: [...request.messages] });
      const step = script.shift();
      if (!step) throw new Error('unexpected call');
      return step(request);
    },
  };
}
const answer =
  (text: string) =>
  (r: CompletionRequest): CompletionResult => {
    r.onText?.(text);
    return {
      content: text,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5 },
      model: r.model,
    };
  };
const callTool =
  (name: string, args = '{}', preamble = '') =>
  (r: CompletionRequest): CompletionResult => {
    if (preamble) r.onText?.(preamble);
    return {
      content: preamble,
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name, arguments: args } },
      ],
      finishReason: 'tool_calls',
      usage: null,
      model: r.model,
    };
  };

function makeService(
  store: ReturnType<typeof fakeStore>,
  llm: LlmClient,
  config: Partial<AiChatConfig> = {},
) {
  const service = new AiChatService(
    store.prisma as any,
    { tools: [invoiceTool], deps: {} } as any,
    store.audit as any,
  );
  service.config = { ...CONFIG, ...config };
  service.llm = llm;
  return service;
}

async function ask(
  service: AiChatService,
  scope: AiScope,
  input: { question: string; conversationId?: number | null },
) {
  const events: Row[] = [];
  await service.ask(
    scope,
    {
      threadId: 'thread-1',
      runId: 'run-1',
      conversationId: input.conversationId ?? null,
      question: input.question,
      page: { path: '/don-hang/hoa-don', title: 'Hoá đơn' },
      chatCustomerId: 5,
    },
    (e) => events.push(e as Row),
    undefined,
    () => NOW,
  );
  return events;
}
const types = (events: Row[]) => events.map((e) => e.type);

describe('AiChatService.ask', () => {
  const SCOPE = scopeOf(['invoices:view', 'customers:view']);

  it('gọi công cụ rồi trả lời, chỉ lưu câu hỏi và câu trả lời', async () => {
    const store = fakeStore();
    const llm = scriptedLlm([
      callTool('invoices_summary', '{"from":"2026-11-01"}', 'Để mình xem.'),
      answer('Tháng này có **3** hoá đơn.'),
    ]);
    const events = await ask(makeService(store, llm), SCOPE, {
      question: 'Doanh thu tháng này?',
    });

    expect(types(events)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    expect(events[1]).toMatchObject({
      snapshot: { conversation: { id: 101, title: 'Doanh thu tháng này?' } },
    });
    expect(events[5]).toMatchObject({
      toolCallName: 'invoices_summary',
      parentMessageId: events[2].messageId,
      metadata: { label: 'Đang tra cứu hoá đơn' },
    });
    // Trình duyệt chỉ biết tra cứu có thành công, không nhận dữ liệu.
    expect(events[8].content).toBe(JSON.stringify({ ok: true }));
    expect(events.at(-1)).toMatchObject({
      threadId: 'thread-1',
      runId: 'run-1',
      result: { conversationId: 101, tools: ['invoices_summary'] },
    });

    // Model nhận kết quả công cụ ở vòng 2.
    const round2 = llm.calls[1].messages;
    expect(round2.at(-1)).toMatchObject({
      role: 'tool',
      content: JSON.stringify({ total: 3, revenue: 12_500_000 }),
    });
    // Ngữ cảnh trang + khách đang chat vào system prompt.
    expect(round2[0].content).toContain('/don-hang/hoa-don');
    expect(round2[0].content).toContain('KH000123');

    // Không lưu kết quả thô của công cụ.
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Doanh thu tháng này?'],
      ['assistant', 'Tháng này có **3** hoá đơn.'],
    ]);
    expect(store.messages[1].toolNames).toEqual(['invoices_summary']);
    expect(JSON.stringify(store.messages)).not.toContain('12500000');

    // Audit: một dòng tra cứu, một dòng hỏi — không chứa nội dung câu hỏi.
    expect(store.audits.map((a) => a.actionCode)).toEqual([
      AUDIT_TOOL,
      AUDIT_ASK,
    ]);
    const askAudit = store.audits[1];
    expect(askAudit.metadata).toMatchObject({
      status: 'ok',
      rounds: 2,
      tools: ['invoices_summary'],
      questionChars: 'Doanh thu tháng này?'.length,
    });
    expect(JSON.stringify(askAudit)).not.toContain('Doanh thu');
  });

  it('đổi sang model dự phòng khi model chính lỗi lúc chưa có chữ', async () => {
    const store = fakeStore();
    const llm = scriptedLlm([
      () => {
        throw new LlmError('anthropic_http_529: overloaded', 529);
      },
      answer('Xin chào'),
    ]);
    const events = await ask(makeService(store, llm), SCOPE, {
      question: 'Chào',
    });
    expect(llm.calls.map((c) => c.model)).toEqual([
      'claude-sonnet-5-5',
      'ocg/deepseek-v4.1-flash',
    ]);
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
    expect(store.messages[1].model).toBe('ocg/deepseek-v4.1-flash');
  });

  it('không đổi model khi đã gửi chữ cho người dùng', async () => {
    const store = fakeStore();
    const llm = scriptedLlm([
      (r) => {
        r.onText?.('Đang trả lời');
        throw new LlmError('stream cut', null);
      },
    ]);
    const events = await ask(makeService(store, llm), SCOPE, {
      question: 'Chào',
    });
    expect(llm.calls).toHaveLength(1);
    // Tin đang mở được đóng trước RUN_ERROR.
    expect(types(events).slice(-2)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR']);
    expect(events.at(-1)).toMatchObject({ code: 'llm_unavailable' });
  });

  it('hết lượt hỏi trong ngày thì báo rate_limited và không gọi model', async () => {
    const store = fakeStore({ asked: 100 });
    const llm = scriptedLlm([]);
    const events = await ask(makeService(store, llm), SCOPE, {
      question: 'Chào',
    });
    expect(types(events)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(events[1]).toMatchObject({ code: 'rate_limited' });
    expect(llm.calls).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it('đếm lượt hỏi từ 00:00 hôm nay theo giờ Việt Nam', async () => {
    const store = fakeStore();
    const service = makeService(store, scriptedLlm([]));
    // 10:00 ngày 22/11 giờ VN → từ 00:00 22/11 VN = 17:00Z ngày 21/11
    await service.askedToday(7, NOW);
    // 01:00 ngày 23/11 giờ VN (18:00Z ngày 22/11) → đã sang ngày mới
    await service.askedToday(7, new Date('2026-11-22T18:00:00.000Z'));
    const since = store.prisma.auditLog.count.mock.calls.map((call: any[]) =>
      (call[0] as Row).where.createdAt.gte.toISOString(),
    );
    expect(since).toEqual([
      '2026-11-21T17:00:00.000Z',
      '2026-11-22T17:00:00.000Z',
    ]);
    expect(store.prisma.auditLog.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: 7, actionCode: AUDIT_ASK }),
    });
  });

  it('câu hỏi rỗng hoặc quá dài thì báo invalid_question', async () => {
    const store = fakeStore();
    const service = makeService(store, scriptedLlm([]));
    for (const question of ['   ', 'x'.repeat(2001)]) {
      const events = await ask(service, SCOPE, { question });
      expect(events.at(-1)).toMatchObject({ code: 'invalid_question' });
    }
  });

  it('hội thoại của người khác thì báo conversation_not_found', async () => {
    const store = fakeStore({
      conversations: [{ id: 5, userId: 99, title: 'Của người khác' }],
    });
    const events = await ask(makeService(store, scriptedLlm([])), SCOPE, {
      question: 'Tiếp',
      conversationId: 5,
    });
    expect(events.at(-1)).toMatchObject({ code: 'conversation_not_found' });
  });

  it('hỏi tiếp gửi kèm lịch sử hội thoại', async () => {
    const store = fakeStore({
      conversations: [{ id: 5, userId: 7, title: 'Cũ' }],
      messages: [
        { id: 1, conversationId: 5, role: 'user', content: 'Câu 1' },
        { id: 2, conversationId: 5, role: 'assistant', content: 'Đáp 1' },
      ],
    });
    const llm = scriptedLlm([answer('Đáp 2')]);
    await ask(makeService(store, llm), SCOPE, {
      question: 'Câu 2',
      conversationId: 5,
    });
    expect(
      llm.calls[0].messages.slice(1).map((m) => [m.role, m.content]),
    ).toEqual([
      ['user', 'Câu 1'],
      ['assistant', 'Đáp 1'],
      ['user', 'Câu 2'],
    ]);
  });

  it('không gửi công cụ người hỏi không có quyền; model gọi bừa thì nhận tool_not_allowed', async () => {
    const store = fakeStore();
    const llm = scriptedLlm([
      callTool('invoices_summary'),
      answer('Bạn không có quyền xem hoá đơn.'),
    ]);
    const noInvoices = scopeOf([]);
    const events = await ask(makeService(store, llm), noInvoices, {
      question: 'Doanh thu?',
    });
    // Không có công cụ nào → không gửi tools cho model.
    expect(llm.calls[0].tools).toBeUndefined();
    expect(events.find((e) => e.type === 'TOOL_CALL_RESULT')).toBeUndefined();
    expect(types(events).at(-1)).toBe('RUN_FINISHED');
  });

  it('dừng giữa chừng thì báo cancelled', async () => {
    const store = fakeStore();
    const abort = new AbortController();
    const llm = scriptedLlm([
      (r) => {
        abort.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    ]);
    const events: Row[] = [];
    await makeService(store, llm).ask(
      SCOPE,
      { threadId: 't', runId: 'r', conversationId: null, question: 'Chào' },
      (e) => events.push(e as Row),
      abort.signal,
      () => NOW,
    );
    expect(events.at(-1)).toMatchObject({ code: 'cancelled' });
    expect(store.audits.at(-1)?.metadata.status).toBe('cancelled');
  });

  it('purgeExpired xoá theo thời hạn lưu', async () => {
    const store = fakeStore();
    const service = makeService(store, scriptedLlm([]), { retentionDays: 90 });
    await expect(service.purgeExpired(NOW)).resolves.toEqual({
      conversations: 2,
      messages: 5,
    });
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(store.prisma.aiChatConversation.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: cutoff } },
    });
  });
});

describe('runTool', () => {
  const ctx = { scope: scopeOf(['invoices:view']), now: NOW, deps: {} as any };

  it('công cụ không có quyền trả tool_not_allowed', async () => {
    const out = await runTool(
      { ...ctx, scope: scopeOf([]) },
      [invoiceTool],
      'invoices_summary',
      '{}',
    );
    expect(out).toEqual({
      ok: false,
      content: JSON.stringify({ error: 'tool_not_allowed' }),
    });
  });

  it('tham số hỏng trả invalid_arguments', async () => {
    const out = await runTool(ctx, [invoiceTool], 'invoices_summary', '{x');
    expect(out.ok).toBe(false);
    expect(out.content).toContain('invalid_arguments');
  });

  it(`cắt kết quả còn ${MAX_RESULT_CHARS} ký tự`, async () => {
    const big: AiTool = {
      ...invoiceTool,
      run: async () => ({ rows: 'x'.repeat(50_000) }),
    };
    const out = await runTool(ctx, [big], 'invoices_summary', '');
    expect(out.ok).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 20);
    expect(out.content.endsWith('(đã cắt bớt)')).toBe(true);
  });

  it('kết quả có error thì ok=false; công cụ ném lỗi thì tool_failed', async () => {
    const withError: AiTool = {
      ...invoiceTool,
      run: async () => ({ error: 'invalid_date' }),
    };
    expect((await runTool(ctx, [withError], 'invoices_summary', '')).ok).toBe(
      false,
    );
    const throwing: AiTool = {
      ...invoiceTool,
      run: async () => {
        throw new Error('db down');
      },
    };
    const out = await runTool(ctx, [throwing], 'invoices_summary', '');
    expect(out).toEqual({
      ok: false,
      content: JSON.stringify({ error: 'tool_failed' }),
    });
  });
});

describe('systemPrompt và input AG-UI', () => {
  it('nêu ngày giờ VN và phạm vi chỉ của mình', () => {
    const text = systemPrompt({
      now: NOW,
      scope: scopeOf([], false),
      page: null,
      branchName: 'Kho Hà Nội',
      chatCustomer: null,
    });
    expect(text).toContain('22/11/2026');
    expect(text).toContain('Kho Hà Nội');
    expect(text).toContain('chỉ dữ liệu do chính mình');
    expect(text).toContain('Không bao giờ đưa số điện thoại');
  });

  it('lastUserText lấy tin user cuối, ghép phần text', () => {
    expect(
      lastUserText([
        { role: 'user', content: 'cũ' },
        { role: 'assistant', content: 'đáp' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Doanh ' },
            { type: 'binary' },
            { type: 'text', text: 'thu?' },
          ],
        },
      ]),
    ).toBe('Doanh thu?');
    expect(lastUserText([])).toBe('');
  });

  it('forwardedContext bỏ đường dẫn lạ và id khách sai', () => {
    expect(
      forwardedContext({
        page: { path: '/khach-hang/lead', title: '  Lead \n ' },
        chatCustomerId: '12',
      }),
    ).toEqual({
      page: { path: '/khach-hang/lead', title: 'Lead' },
      chatCustomerId: 12,
    });
    expect(
      forwardedContext({
        page: { path: 'https://evil.com', title: 'x' },
        chatCustomerId: -1,
      }),
    ).toEqual({ page: null, chatCustomerId: null });
    expect(forwardedContext(undefined)).toEqual({
      page: null,
      chatCustomerId: null,
    });
  });
});
