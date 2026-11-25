import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as compression from 'compression';
import type { AddressInfo } from 'node:net';
import { EventType } from '@ag-ui/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AiAssistantController } from './ai-assistant.controller';
import { AiChatService, type AgentEvent } from './ai-chat.service';
import { compressUnlessAiStream } from './ai-stream.util';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/ai/agent qua HTTP thật, có compression() y như main.ts: sự kiện AG-UI phải đến
 * trình duyệt từng phần ngay khi phát, không bị nén dồn lại đến cuối.
 */
describe('POST /api/ai/agent (giao thức stream)', () => {
  let app: INestApplication;
  let base: string;
  const seen: { question?: string; conversationId?: number | null } = {};

  beforeAll(async () => {
    const chat = {
      ready: true,
      ask: async (
        _scope: unknown,
        input: { question: string; conversationId: number | null },
        emit: (e: AgentEvent) => void,
      ) => {
        seen.question = input.question;
        seen.conversationId = input.conversationId;
        emit({
          type: EventType.RUN_STARTED,
          threadId: 't',
          runId: 'r',
        } as AgentEvent);
        await sleep(300);
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'm',
          delta: 'Xin chào',
        } as AgentEvent);
        await sleep(300);
        emit({
          type: EventType.RUN_FINISHED,
          threadId: 't',
          runId: 'r',
        } as AgentEvent);
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AiAssistantController],
      providers: [
        { provide: AiChatService, useValue: chat },
        { provide: PrismaService, useValue: {} },
        { provide: AuditLogsService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(compression({ filter: compressUnlessAiStream }));
    app.use((req: any, _res: unknown, next: () => void) => {
      req.user = {
        id: 1,
        name: 'Admin',
        roles: ['Super Admin'],
        canViewOtherStaffData: true,
        branchIds: [],
        branchId: null,
      };
      next();
    });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => app.close());

  const body = (threadId: string) =>
    JSON.stringify({
      threadId,
      runId: 'run-1',
      state: {},
      messages: [{ id: 'u1', role: 'user', content: 'Doanh thu hôm nay?' }],
      tools: [],
      context: [],
      forwardedProps: { page: { path: '/don-hang/hoa-don', title: 'HĐ' } },
    });

  it('stream SSE không nén, sự kiện đến dần', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/api/ai/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: body('42'),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: Array<{ at: number; type: string }> = [];
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith('data:')) continue;
        const event = JSON.parse(frame.slice(5)) as { type: string };
        arrivals.push({ at: Date.now() - started, type: event.type });
      }
    }
    expect(arrivals.map((a) => a.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]);
    // RUN_STARTED đến trước khi cả lượt chạy xong (~600ms) — không bị dồn.
    expect(arrivals[2].at - arrivals[0].at).toBeGreaterThanOrEqual(400);
    // threadId là số → hỏi tiếp hội thoại đã lưu; câu hỏi lấy từ tin user cuối.
    expect(seen).toEqual({
      question: 'Doanh thu hôm nay?',
      conversationId: 42,
    });
  });

  it('threadId không phải số → hội thoại mới; input sai → 400', async () => {
    await (
      await fetch(`${base}/api/ai/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body('0b8f6c1e-uuid'),
      })
    ).text();
    expect(seen.conversationId).toBeNull();

    const bad = await fetch(`${base}/api/ai/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 1 }),
    });
    expect(bad.status).toBe(400);
  });

  it('API khác vẫn được nén như cũ', () => {
    const req = { originalUrl: '/api/leads', headers: {} } as any;
    const res = {
      getHeader: (h: string) =>
        h.toLowerCase() === 'content-type' ? 'application/json' : undefined,
    } as any;
    expect(compressUnlessAiStream(req, res)).toBe(true);
    expect(
      compressUnlessAiStream({ ...req, originalUrl: '/api/ai/agent' }, res),
    ).toBe(false);
  });
});
