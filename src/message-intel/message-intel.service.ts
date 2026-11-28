import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IntelVersion } from './providers/classifier.interface';
import {
  buildJevQuestions,
  DEFAULT_THRESHOLDS,
  type IntelThresholds,
  JEV_MODEL,
  type JevQuestion,
} from './taxonomy/taxonomy-v1';
import { alertSettings, LARK_CHAT_ID, vnDay } from './message-intel.config';

export type Actor = { id: number; name: string };
const AUDIT_CATEGORY = 'message_intel';
const VERSION_TTL_MS = 30_000;
const PAGES_TTL_MS = 5 * 60_000;

/**
 * Điều khiển Message Intelligence: phiên bản taxonomy, tạm dừng / tiếp tục, backfill, ngân sách token
 * ngày, thống kê hàng đợi. Worker đọc trạng thái ở đây; thao tác quản trị đều ghi audit.
 */
@Injectable()
export class MessageIntelService {
  private versionCache?: { at: number; value: IntelVersion | null };
  private pagesCache?: { at: number; value: Set<string> };

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Phiên bản đang chạy (cache 30 giây). */
  async activeVersion(): Promise<IntelVersion | null> {
    if (this.versionCache && Date.now() - this.versionCache.at < VERSION_TTL_MS)
      return this.versionCache.value;
    const row = await this.prisma.smaxIntelVersion.findFirst({
      where: { status: 'active' },
    });
    const value = row
      ? {
          id: row.id,
          model: row.model,
          questions: row.questions as Record<string, JevQuestion>,
          thresholds: row.thresholds as IntelThresholds,
        }
      : null;
    this.versionCache = { at: Date.now(), value };
    return value;
  }

  async activatedAt() {
    return (
      await this.prisma.smaxIntelVersion.findFirst({
        where: { status: 'active' },
        select: { activatedAt: true },
      })
    )?.activatedAt;
  }

  /** Kênh Smax của công ty đang lưu tin (pid gửi = kênh mình; cũng là phạm vi page_pid của kho tin). */
  async ourPagePids(): Promise<Set<string>> {
    if (this.pagesCache && Date.now() - this.pagesCache.at < PAGES_TTL_MS)
      return this.pagesCache.value;
    const rows = await this.prisma.smaxSyncChannel.findMany({
      select: { pagePid: true },
    });
    const value = new Set(rows.map((r) => r.pagePid));
    this.pagesCache = { at: Date.now(), value };
    return value;
  }

  runtime() {
    return this.prisma.smaxIntelRuntime.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  /** Token còn được dùng hôm nay (giờ VN). */
  async budgetLeft() {
    const r = await this.runtime();
    return r.budgetDay === vnDay()
      ? r.dailyTokenBudget - r.tokensToday
      : r.dailyTokenBudget;
  }

  /** Cộng token đã dùng (sang ngày mới thì đếm lại từ đầu). */
  async consumeTokens(tokens: number) {
    if (!(tokens > 0)) return;
    const day = vnDay();
    await this.prisma.$executeRaw`
      UPDATE smax_intel_runtime
      SET tokens_today = CASE WHEN budget_day = ${day} THEN tokens_today + ${tokens} ELSE ${tokens} END,
          budget_day = ${day}
      WHERE id = 1`;
  }

  async status() {
    const [runtime, versions] = await Promise.all([
      this.runtime(),
      this.prisma.smaxIntelVersion.findMany({
        select: {
          id: true,
          name: true,
          model: true,
          status: true,
          activatedAt: true,
          createdAt: true,
        },
        orderBy: { id: 'desc' },
      }),
    ]);
    const active = versions.find((v) => v.status === 'active');
    const counts = active
      ? await this.prisma.smaxMessageIntel.groupBy({
          by: ['status'],
          where: { versionId: active.id },
          _count: { _all: true },
          _sum: { inputTokens: true },
        })
      : [];
    // Điểm bắt đầu quét backfill (cùng cách startBackfill chọn) → màn hình tính % tiến độ
    const backfillStart =
      runtime.backfillStatus === 'running' && runtime.backfillFrom
        ? await this.prisma.smaxMessage.findFirst({
            where: { createdAt: { gte: runtime.backfillFrom } },
            orderBy: { id: 'asc' },
            select: { id: true },
          })
        : null;
    return {
      runtime: {
        ...runtime,
        discoveryCursor: runtime.discoveryCursor.toString(),
        backfillCursor: runtime.backfillCursor.toString(),
        backfillUntilId: runtime.backfillUntilId.toString(),
        backfillStartId: backfillStart
          ? (backfillStart.id - 1n).toString()
          : null,
        tokensToday: runtime.budgetDay === vnDay() ? runtime.tokensToday : 0,
      },
      versions,
      alerts: {
        ...alertSettings(runtime),
        recent: await this.prisma.smaxIntelAlert.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            pagePid: true,
            tid: true,
            reason: true,
            status: true,
            messageAt: true,
            createdAt: true,
            error: true,
          },
        }),
      },
      queue: Object.fromEntries(
        counts.map((c) => [
          c.status,
          { count: c._count._all, inputTokens: c._sum.inputTokens ?? 0 },
        ]),
      ),
    };
  }

  /** Tạo phiên bản nháp từ taxonomy v1 trong code (ngưỡng tuỳ chọn, vd sau benchmark). */
  async createVersionV1(
    actor: Actor,
    name = 'v1',
    thresholds: IntelThresholds = DEFAULT_THRESHOLDS,
  ) {
    if (!(thresholds.no < thresholds.yes))
      throw new BadRequestException('Ngưỡng "không" phải nhỏ hơn ngưỡng "có"');
    const version = await this.prisma.smaxIntelVersion.create({
      data: {
        name,
        model: JEV_MODEL,
        questions: buildJevQuestions() as object,
        thresholds: { ...thresholds },
        status: 'draft',
        createdBy: actor.id,
      },
    });
    await this.audit(
      actor,
      'MESSAGE_INTEL_VERSION_CREATE',
      `Tạo phiên bản phân loại tin "${name}" (#${version.id})`,
      { versionId: version.id, thresholds },
    );
    return version;
  }

  /**
   * Kích hoạt 1 phiên bản nháp (phiên bản đang chạy chuyển retired). Quét tin mới bắt đầu từ tin lưu sau
   * thời điểm này; tin cũ hơn chỉ xử lý khi chạy backfill.
   */
  async activate(versionId: number, actor: Actor) {
    const version = await this.prisma.smaxIntelVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException('Không có phiên bản này');
    if (version.status !== 'draft')
      throw new BadRequestException(
        'Chỉ kích hoạt được phiên bản nháp (phiên bản đã dùng không sửa / dùng lại)',
      );
    const max = await this.prisma.smaxMessage.aggregate({ _max: { id: true } });
    await this.prisma.$transaction([
      this.prisma.smaxIntelVersion.updateMany({
        where: { status: 'active' },
        data: { status: 'retired' },
      }),
      this.prisma.smaxIntelVersion.update({
        where: { id: versionId },
        data: { status: 'active', activatedAt: new Date() },
      }),
      this.prisma.smaxIntelRuntime.upsert({
        where: { id: 1 },
        create: { id: 1, discoveryCursor: max._max.id ?? 0n },
        update: {
          discoveryCursor: max._max.id ?? 0n,
          backfillStatus: null,
          updatedBy: actor.id,
        },
      }),
    ]);
    this.versionCache = undefined;
    await this.audit(
      actor,
      'MESSAGE_INTEL_VERSION_ACTIVATE',
      `Kích hoạt phiên bản phân loại tin "${version.name}" (#${versionId})`,
      { versionId },
    );
  }

  async setPaused(paused: boolean, actor: Actor) {
    await this.runtime();
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: { paused, updatedBy: actor.id },
    });
    await this.audit(
      actor,
      paused ? 'MESSAGE_INTEL_PAUSE' : 'MESSAGE_INTEL_RESUME',
      paused ? 'Tạm dừng phân loại tin' : 'Tiếp tục phân loại tin',
    );
  }

  async setBudget(tokens: number, actor: Actor) {
    await this.runtime();
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: { dailyTokenBudget: tokens, updatedBy: actor.id },
    });
    await this.audit(
      actor,
      'MESSAGE_INTEL_BUDGET',
      `Đặt ngân sách phân loại tin ${tokens} token/ngày`,
      { tokens },
    );
  }

  /**
   * Cảnh báo Lark: bật / tắt, đổi nhóm nhận (chat id oc_…; rỗng = nhóm mặc định). Đổi nhóm → topic của ngày
   * bắt đầu lại trong nhóm mới.
   */
  async setAlerts(
    input: { enabled?: boolean; chatId?: string | null },
    actor: Actor,
  ) {
    const runtime = await this.runtime();
    const data: {
      alertsEnabled?: boolean;
      alertChatId?: string | null;
      alertDay?: null;
      alertRootMessageId?: null;
      updatedBy: number;
    } = { updatedBy: actor.id };
    const changes: string[] = [];
    if (
      input.enabled !== undefined &&
      input.enabled !== runtime.alertsEnabled
    ) {
      data.alertsEnabled = input.enabled;
      changes.push(
        input.enabled ? 'bật gửi cảnh báo Lark' : 'tắt gửi cảnh báo Lark',
      );
    }
    if (input.chatId !== undefined) {
      const chatId = input.chatId?.trim() || null;
      if (chatId && !LARK_CHAT_ID.test(chatId))
        throw new BadRequestException(
          'Chat id nhóm Lark không hợp lệ (dạng oc_…)',
        );
      if (chatId !== runtime.alertChatId) {
        Object.assign(data, {
          alertChatId: chatId,
          alertDay: null,
          alertRootMessageId: null,
        });
        changes.push(
          `đổi nhóm nhận cảnh báo sang ${chatId ?? 'nhóm mặc định'}`,
        );
      }
    }
    if (!changes.length) return;
    await this.prisma.smaxIntelRuntime.update({ where: { id: 1 }, data });
    await this.audit(
      actor,
      'MESSAGE_INTEL_ALERTS',
      `Cảnh báo phân loại tin: ${changes.join(', ')}`,
      {
        from: { enabled: runtime.alertsEnabled, chatId: runtime.alertChatId },
        to: input,
      },
    );
  }

  /** Backfill tin cũ trong [from, to] (tuỳ chọn giới hạn kênh), tới tin lớn nhất đang có lúc bắt đầu. */
  async startBackfill(
    input: { from: Date; to: Date; pagePids?: string[] },
    actor: Actor,
  ) {
    if (!(await this.activeVersion()))
      throw new BadRequestException('Chưa có phiên bản đang chạy');
    if (!(input.from < input.to))
      throw new BadRequestException('Khoảng ngày không hợp lệ');
    const [max, first] = await Promise.all([
      this.prisma.smaxMessage.aggregate({ _max: { id: true } }),
      // Tin tạo sau `from` được lưu sau `from` → id ≥ tin đầu tiên này: bắt đầu quét ngay trước nó
      this.prisma.smaxMessage.findFirst({
        where: { createdAt: { gte: input.from } },
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
    ]);
    const until = max._max.id ?? 0n;
    await this.runtime();
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: {
        backfillStatus: 'running',
        backfillCursor: first ? first.id - 1n : until,
        backfillUntilId: until,
        backfillFrom: input.from,
        backfillTo: input.to,
        backfillPagePids: input.pagePids ?? [],
        updatedBy: actor.id,
      },
    });
    await this.audit(
      actor,
      'MESSAGE_INTEL_BACKFILL',
      `Bắt đầu phân loại tin cũ ${input.from.toISOString()} → ${input.to.toISOString()}${input.pagePids?.length ? ` (${input.pagePids.length} kênh)` : ''}`,
      {
        from: input.from,
        to: input.to,
        pagePids: input.pagePids ?? [],
      },
    );
  }

  async cancelBackfill(actor: Actor) {
    await this.runtime();
    await this.prisma.smaxIntelRuntime.update({
      where: { id: 1 },
      data: { backfillStatus: null, updatedBy: actor.id },
    });
    await this.audit(
      actor,
      'MESSAGE_INTEL_BACKFILL_CANCEL',
      'Dừng phân loại tin cũ',
    );
  }

  /** Đưa các tin lỗi hẳn (failed) của phiên bản đang chạy về hàng đợi. */
  async retryFailed(actor: Actor) {
    const version = await this.activeVersion();
    if (!version) throw new BadRequestException('Chưa có phiên bản đang chạy');
    const { count } = await this.prisma.smaxMessageIntel.updateMany({
      where: { versionId: version.id, status: 'failed' },
      data: {
        status: 'pending',
        attemptCount: 0,
        nextRetryAt: new Date(),
        lastError: null,
        claimToken: null,
        lockedUntil: null,
      },
    });
    await this.audit(
      actor,
      'MESSAGE_INTEL_RETRY',
      `Thử lại ${count} tin phân loại lỗi`,
      { count },
    );
    return { count };
  }

  private audit(
    actor: Actor,
    actionCode: string,
    message: string,
    metadata?: object,
  ) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'smax_message_intel',
      category: AUDIT_CATEGORY,
      message,
      userId: actor.id,
      userName: actor.name || 'Hệ thống',
      metadata,
    });
  }
}
