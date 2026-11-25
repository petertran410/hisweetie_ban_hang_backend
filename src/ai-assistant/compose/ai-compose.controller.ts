import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../../auth/request-permissions';
import {
  AiComposeService,
  COMPOSE_MODES,
  REWRITE_STYLES,
  THREAD_LABELS,
  type ThreadLabel,
  type ComposeActor,
  type ComposeMode,
  type RewriteStyle,
} from './ai-compose.service';
import { UpsellService } from './upsell.service';
import { DailyReportService } from './daily-report.service';

export class ComposeDto {
  @IsIn(COMPOSE_MODES)
  mode: ComposeMode;

  @IsString()
  @MaxLength(64)
  pagePid: string;

  @IsString()
  @Matches(/^[a-z]{2,4}[A-Za-z0-9_-]{3,64}$/)
  tid: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customerId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  draft?: string;

  @IsOptional()
  @IsIn(Object.keys(REWRITE_STYLES))
  style?: RewriteStyle;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  facts?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unreadCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  messageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @Matches(/^[a-z]{2,4}[A-Za-z0-9_-]{3,64}$/, { each: true })
  tids?: string[];
}

export class ThreadLabelDto {
  @IsString()
  @MaxLength(64)
  pagePid: string;

  @IsString()
  @Matches(/^[a-z]{2,4}[A-Za-z0-9_-]{3,64}$/)
  tid: string;

  @IsIn(THREAD_LABELS)
  label: ThreadLabel;
}

type ComposeRequest = {
  user: { id: number; name: string; canViewOtherStaffData?: boolean };
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * `/api/ai/compose`: AI soạn nháp tin trong ô chat Smax. Ai gửi được tin (smax_chat:send) thì
 * dùng được; chỉ trả nháp, không gửi gì cho khách.
 */
@ApiTags('AI Assistant')
@ApiBearerAuth()
@RequirePermissions('smax_chat:send')
@Controller('ai/compose')
export class AiComposeController {
  constructor(
    private readonly compose: AiComposeService,
    private readonly upsell: UpsellService,
    private readonly daily: DailyReportService,
  ) {}

  private actor(req: ComposeRequest): ComposeActor {
    const raw = req.headers?.['x-branch-id'];
    const branchId = raw ? parseInt(String(raw), 10) : NaN;
    return {
      id: req.user.id,
      name: req.user.name,
      canViewOtherStaffData: !!req.user.canViewOtherStaffData,
      branchId: Number.isFinite(branchId) ? branchId : null,
      can: (permission) => requestHasPermission(req, permission),
    };
  }

  /** Bật hay không + số lượt còn lại hôm nay. */
  @Get('status')
  async status(@Req() req: ComposeRequest) {
    const used = await this.compose.usedToday(req.user.id);
    return {
      enabled: this.compose.ready,
      limitPerDay: this.compose.limitPerDay,
      remaining: Math.max(0, this.compose.limitPerDay - used),
    };
  }

  /** Gợi ý bán thêm (thống kê hoá đơn, không gọi AI) — ai xem được chat là xem được. */
  @Get('upsell/:customerId')
  @RequirePermissions('smax_chat:view')
  upsellFor(
    @Param('customerId', ParseIntPipe) customerId: number,
    @Req() req: ComposeRequest,
  ) {
    return this.upsell.forCustomer(this.actor(req), customerId);
  }

  /**
   * Xem trước báo cáo chat cuối ngày (không gửi Lark). POST bắt đầu (chạy nền vài phút),
   * GET lấy kết quả. Quyền dùng Trợ lý AI (Admin / Trưởng BP Sale).
   */
  @Post('daily-report/preview')
  @RequirePermissions('ai_assistant:use')
  startDailyPreview(@Query('date') date?: string) {
    return this.daily.startPreview(
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    );
  }

  @Get('daily-report/preview')
  @RequirePermissions('ai_assistant:use')
  dailyPreview() {
    return this.daily.getPreview();
  }

  /** Gửi bản xem trước đang có vào nhóm Lark (nhân viên bấm "Gửi vào Lark" ở POS). */
  @Post('daily-report/preview/send')
  @RequirePermissions('ai_assistant:use')
  sendDailyPreview(@Req() req: ComposeRequest) {
    const { id, name } = this.actor(req);
    return this.daily.sendPreview({ id, name });
  }

  /** Báo cáo chat cuối ngày đã gửi Lark / đã lưu: danh sách các bản, và nội dung một bản (theo id). */
  @Get('daily-report/saved')
  @RequirePermissions('ai_assistant:use')
  dailySavedReports() {
    return this.daily.savedReports();
  }

  @Get('daily-report/saved/:id')
  @RequirePermissions('ai_assistant:use')
  async dailySaved(@Param('id', ParseIntPipe) id: number) {
    return (await this.daily.savedReport(id)) ?? { at: null, sent: false, by: null, report: null };
  }

  /** Gửi một bản đã lưu vào nhóm Lark (mỗi bản lưu gửi một lần). */
  @Post('daily-report/saved/:id/send')
  @RequirePermissions('ai_assistant:use')
  sendDailySaved(@Param('id', ParseIntPipe) id: number, @Req() req: ComposeRequest) {
    const { id: userId, name } = this.actor(req);
    return this.daily.sendSaved(id, { id: userId, name });
  }

  /** Lưu bản xem trước đang có (không gửi Lark) để xem lại trên POS. */
  @Post('daily-report/preview/save')
  @RequirePermissions('ai_assistant:use')
  saveDailyPreview(@Req() req: ComposeRequest) {
    const { id, name } = this.actor(req);
    return this.daily.savePreview({ id, name });
  }

  /** Sửa nhãn phân loại hội thoại tay. */
  @Patch('labels')
  @RequirePermissions('smax_chat:view')
  setLabel(@Body() dto: ThreadLabelDto, @Req() req: ComposeRequest) {
    return this.compose.setLabel(this.actor(req), dto);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  run(@Body() dto: ComposeDto, @Req() req: ComposeRequest) {
    return this.compose.run(this.actor(req), dto);
  }
}
