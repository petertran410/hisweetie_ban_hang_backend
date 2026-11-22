import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { EventEncoder } from '@ag-ui/encoder';
import { EventType } from '@ag-ui/core';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { buildAiScope, type AiRequest } from './ai-scope';
import {
  AiChatService,
  MAX_QUESTION_CHARS,
  type AgentEvent,
} from './ai-chat.service';

// `@ag-ui/core/schemas` chỉ khai báo qua "exports" — TS (moduleResolution node) không đọc được
// subpath này, nên lấy kiểu từ file dist và require lúc chạy.
const { RunAgentInputSchema } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@ag-ui/core/schemas') as typeof import('@ag-ui/core/dist/schemas');

/** Tin user cuối của input AG-UI: chuỗi, hoặc các phần text ghép lại. */
export function lastUserText(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): string {
  const message = [...messages].reverse().find((item) => item.role === 'user');
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part: unknown) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      return p && typeof p === 'object' && p.type === 'text'
        ? typeof p.text === 'string'
          ? p.text
          : ''
        : '';
    })
    .join('');
}

/** `forwardedProps`: trang đang mở và khách đang chat — cắt gọn, sai dạng thì bỏ. */
export function forwardedContext(forwardedProps: unknown): {
  page: { path: string; title: string } | null;
  chatCustomerId: number | null;
} {
  const props =
    forwardedProps && typeof forwardedProps === 'object'
      ? (forwardedProps as Record<string, unknown>)
      : {};
  const raw = props.page as Record<string, unknown> | undefined;
  const path = typeof raw?.path === 'string' ? raw.path : '';
  const title = typeof raw?.title === 'string' ? raw.title : '';
  const page = /^\/[\w\-/]*$/.test(path)
    ? {
        path: path.slice(0, 100),
        title: title.replace(/\s+/g, ' ').trim().slice(0, 80),
      }
    : null;
  const id = Number(props.chatCustomerId);
  return {
    page,
    chatCustomerId: Number.isInteger(id) && id > 0 ? id : null,
  };
}

/**
 * `/api/ai/*`: Trợ lý AI chỉ đọc. Hội thoại riêng của từng người. `POST /api/ai/agent` là
 * endpoint agent AG-UI: nhận RunAgentInput, stream sự kiện AG-UI; chỉ đọc tin user mới nhất,
 * lịch sử / công cụ / ngữ cảnh do server tự lấy.
 */
@ApiTags('AI Assistant')
@ApiBearerAuth()
@RequirePermissions('ai_assistant:use')
@Controller('ai')
export class AiAssistantController {
  private readonly logger = new Logger(AiAssistantController.name);

  constructor(
    private readonly chat: AiChatService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('config')
  async config(@Req() req: AiRequest) {
    const { config, ready } = this.chat;
    const asked = await this.chat.askedToday(req.user.id);
    return {
      enabled: ready,
      ready,
      maxQuestionChars: MAX_QUESTION_CHARS,
      rateLimitPerDay: config.rateLimitPerDay,
      remaining: Math.max(0, config.rateLimitPerDay - asked),
      retentionDays: config.retentionDays,
    };
  }

  @Get('conversations')
  async conversations(@Req() req: AiRequest, @Query('search') search?: string) {
    const q = search?.trim().slice(0, 100);
    const items = await this.prisma.aiChatConversation.findMany({
      where: {
        userId: req.user.id,
        ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return { items };
  }

  @Get('conversations/:id')
  async conversation(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AiRequest,
  ) {
    const conversation = await this.prisma.aiChatConversation.findFirst({
      where: { id, userId: req.user.id },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            toolNames: true,
            createdAt: true,
          },
        },
      },
    });
    if (!conversation)
      throw new NotFoundException('Không tìm thấy cuộc trò chuyện này');
    return conversation;
  }

  @Delete('conversations/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: AiRequest) {
    const deleted = await this.prisma.aiChatConversation.deleteMany({
      where: { id, userId: req.user.id },
    });
    if (!deleted.count)
      throw new NotFoundException('Không tìm thấy cuộc trò chuyện này');
    return { ok: true };
  }

  // Lượt hỏi đã giới hạn theo ngày (AI_RATE_LIMIT_PER_DAY); đây chặn bấm dồn.
  @Post('agent')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async agent(@Req() req: Request & AiRequest, @Res() res: Response) {
    if (!this.chat.ready)
      throw new ServiceUnavailableException('Trợ lý AI đang tắt');
    const parsed = RunAgentInputSchema.safeParse(req.body);
    if (
      !parsed.success ||
      parsed.data.threadId.length > 100 ||
      parsed.data.runId.length > 100
    )
      throw new BadRequestException('Dữ liệu gửi trợ lý không hợp lệ');
    const input = parsed.data;
    // threadId là số = hội thoại đã lưu (chỉ khi là của người hỏi — kiểm ở AiChatService);
    // id khác (uuid client) = hội thoại mới.
    const conversationId = /^\d{1,9}$/.test(input.threadId)
      ? Number(input.threadId)
      : null;
    const scope = buildAiScope(req);
    const { page, chatCustomerId } = forwardedContext(input.forwardedProps);

    const encoder = new EventEncoder({
      accept: req.headers.accept ?? 'text/event-stream',
    });
    res.status(200);
    res.setHeader('Content-Type', encoder.getContentType());
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const emit = (event: AgentEvent) => {
      if (!res.writableEnded) res.write(encoder.encodeBinary(event));
    };
    // Comment SSE giữ cho proxy không cắt luồng im lặng khi công cụ đang chạy.
    const sse = encoder.getContentType().startsWith('text/event-stream');
    const heartbeat = setInterval(() => {
      if (sse && !res.writableEnded) res.write(': heartbeat\n\n');
    }, 15_000);
    let finished = false;
    const track = (event: AgentEvent) => {
      if (
        event.type === EventType.RUN_FINISHED ||
        event.type === EventType.RUN_ERROR
      )
        finished = true;
      emit(event);
    };
    try {
      await this.chat.ask(
        scope,
        {
          threadId: input.threadId,
          runId: input.runId,
          conversationId,
          question: lastUserText(input.messages),
          page,
          chatCustomerId,
        },
        track,
        abort.signal,
      );
    } catch (error) {
      this.logger.error(
        `Trợ lý AI lỗi: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!finished)
        emit({
          type: EventType.RUN_ERROR,
          code: 'internal_error',
          message: 'Trợ lý gặp lỗi. Vui lòng thử lại.',
          timestamp: Date.now(),
        } as AgentEvent);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
