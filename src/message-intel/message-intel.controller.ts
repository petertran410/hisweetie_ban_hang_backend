import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../auth/request-permissions';
import { IntelControlDto } from './dto/intel-control.dto';
import {
  ExcludeThreadDto,
  IntelMessagesQueryDto,
  IntelRangeQueryDto,
  RemoveExclusionDto,
  SandboxDto,
  SaveReviewDto,
} from './dto/intel-query.dto';
import { type Actor, MessageIntelService } from './message-intel.service';
import { MessageIntelQueryService } from './message-intel-query.service';
import { MessageIntelExclusionService } from './message-intel-exclusion.service';
import { intelConfig } from './message-intel.config';
import { JevProvider } from './providers/jev.provider';

type AuthedRequest = { user: { id: number; name: string } };
/** Nội dung tin khách chỉ cho người được xem chat Smax. */
const CHAT_VIEW = 'smax_chat:view';

/**
 * Message Intelligence (AI phân loại tin Smax). Xem: message_intel:view (nội dung tin cần thêm
 * smax_chat:view); điều khiển / thử nghiệm: message_intel:manage.
 */
@Controller('message-intel')
export class MessageIntelController {
  constructor(
    private readonly intel: MessageIntelService,
    private readonly query: MessageIntelQueryService,
    private readonly jev: JevProvider,
    private readonly exclusions: MessageIntelExclusionService,
  ) {}

  @Get('status')
  @RequirePermissions('message_intel:view')
  async status() {
    const cfg = intelConfig();
    return {
      ...(await this.intel.status()),
      config: {
        enabled: cfg.enabled,
        dryRun: cfg.dryRun,
        pagePids: cfg.pagePids,
        concurrency: cfg.concurrency,
        batch: cfg.batch,
        jevConfigured: this.jev.configured,
        jevFallbackConfigured: this.jev.fallbackConfigured,
      },
    };
  }

  @Get('overview')
  @RequirePermissions('message_intel:view')
  overview(@Query() q: IntelRangeQueryDto) {
    return this.query.overview(
      { from: q.from, to: q.to, pagePid: q.pagePid },
      q.versionId,
    );
  }

  @Get('messages')
  @RequirePermissions('message_intel:view')
  messages(@Query() q: IntelMessagesQueryDto, @Req() req: AuthedRequest) {
    return this.query.messages(q, requestHasPermission(req, CHAT_VIEW));
  }

  @Get('reviews/next')
  @RequirePermissions('message_intel:view')
  nextReview(@Query('versionId') versionId: string, @Req() req: AuthedRequest) {
    this.requireChatView(req);
    return this.query.nextReview(req.user.id, Number(versionId) || undefined);
  }

  @Post('reviews')
  @RequirePermissions('message_intel:view')
  saveReview(@Body() dto: SaveReviewDto, @Req() req: AuthedRequest) {
    this.requireChatView(req);
    return this.query.saveReview(req.user.id, dto);
  }

  @Get('reviews/summary')
  @RequirePermissions('message_intel:view')
  reviewSummary(@Query('versionId') versionId: string) {
    return this.query.reviewSummary(Number(versionId) || undefined);
  }

  /** Hồ sơ AI của khách POS (khung chat): đếm khiếu nại / bất thường / đặt hàng 90 ngày, tin vấn đề gần nhất. */
  @Get('customers/:id/summary')
  @RequirePermissions(CHAT_VIEW)
  async customerSummary(@Param('id', ParseIntPipe) id: number) {
    return (
      (await this.query.customerSummary(id, 90, true)) ?? { enabled: false }
    );
  }

  @Post('sandbox')
  @RequirePermissions('message_intel:manage')
  sandbox(@Body() dto: SandboxDto) {
    return this.query.sandbox(dto);
  }

  @Post('control')
  @RequirePermissions('message_intel:manage')
  async control(@Body() dto: IntelControlDto, @Req() req: AuthedRequest) {
    const actor: Actor = { id: req.user.id, name: req.user.name };
    switch (dto.action) {
      case 'create_version_v1':
        return this.intel.createVersionV1(actor, dto.name, dto.thresholds);
      case 'activate':
        if (!dto.versionId) throw new BadRequestException('Thiếu versionId');
        await this.intel.activate(dto.versionId, actor);
        break;
      case 'pause':
      case 'resume':
        await this.intel.setPaused(dto.action === 'pause', actor);
        break;
      case 'backfill':
        if (!dto.from || !dto.to)
          throw new BadRequestException('Thiếu khoảng ngày from / to');
        await this.intel.startBackfill(
          { from: dto.from, to: dto.to, pagePids: dto.pagePids },
          actor,
        );
        break;
      case 'cancel_backfill':
        await this.intel.cancelBackfill(actor);
        break;
      case 'retry_failed':
        return this.intel.retryFailed(actor);
      case 'set_alerts':
        await this.intel.setAlerts(
          { enabled: dto.alertsEnabled, chatId: dto.alertChatId },
          actor,
        );
        break;
      case 'set_budget':
        if (dto.tokens === undefined)
          throw new BadRequestException('Thiếu tokens');
        await this.intel.setBudget(dto.tokens, actor);
        break;
    }
    return { ok: true };
  }

  /** Hội thoại loại trừ khỏi phân loại tin (không gửi AI): chỉ quản trị (message_intel:manage). */
  @Get('exclusions')
  @RequirePermissions('message_intel:manage')
  listExclusions() {
    return this.exclusions.list();
  }

  @Get('exclusions/threads')
  @RequirePermissions('message_intel:manage')
  searchThreads(@Query('q') q?: string) {
    return this.exclusions.searchThreads(String(q ?? '').slice(0, 100));
  }

  @Post('exclusions')
  @RequirePermissions('message_intel:manage')
  exclude(@Body() dto: ExcludeThreadDto, @Req() req: AuthedRequest) {
    return this.exclusions.add(
      { pagePid: dto.pagePid, tid: dto.tid },
      { id: req.user.id, name: req.user.name },
    );
  }

  @Post('exclusions/remove')
  @RequirePermissions('message_intel:manage')
  removeExclusion(@Body() dto: RemoveExclusionDto, @Req() req: AuthedRequest) {
    return this.exclusions.remove(dto, {
      id: req.user.id,
      name: req.user.name,
    });
  }

  private requireChatView(req: AuthedRequest) {
    if (!requestHasPermission(req, CHAT_VIEW))
      throw new ForbiddenException('Cần quyền xem chat Smax để chấm nhãn');
  }
}
