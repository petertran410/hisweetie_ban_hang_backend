import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { daysSince } from './price-change.calc';
import {
  PcStage,
  REMINDER_STAGES,
  STAGE_GROUP,
} from './price-change.constants';
import { PriceChangeConfigService } from './price-change-config.service';
import { PriceChangeNotifyService } from './price-change-notify.service';

const TZ = 'Asia/Ho_Chi_Minh';

export type PcReminderResult = Record<
  string,
  { tickets: number; recipients: number }
>;

/**
 * Nhắc việc hằng ngày 17:00 (khuôn nhắc việc Bảng giá SP mới): mỗi bước Kế toán trưởng /
 * CEO / Phòng Dữ Liệu 1 tin riêng tổng hợp các phiếu đang chờ, gửi người trong nhóm của bước.
 * Gồm cả phiếu chưa từng được báo (vd nhập từ Lark).
 */
@Injectable()
export class PriceChangeReminderCron {
  private readonly logger = new Logger(PriceChangeReminderCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pcConfig: PriceChangeConfigService,
    private readonly notify: PriceChangeNotifyService,
  ) {}

  @Cron('0 17 * * *', { name: 'price-change-reminder-17h', timeZone: TZ })
  async remindAt17() {
    await this.runStages(REMINDER_STAGES);
  }

  /** `force` = bấm "Gửi nhắc việc ngay": gửi kể cả khi đang tắt nhắc việc. */
  async runStages(stages: PcStage[], force = false): Promise<PcReminderResult> {
    const out: PcReminderResult = {};
    for (const stage of stages) {
      try {
        out[stage] = await this.runStage(stage, force);
      } catch (err) {
        this.logger.error(
          `Nhắc việc thay đổi giá ${stage} lỗi: ${(err as Error)?.message}`,
        );
        out[stage] = { tickets: 0, recipients: 0 };
      }
    }
    return out;
  }

  private async runStage(stage: PcStage, force: boolean) {
    const cfg = await this.pcConfig.get();
    if (!cfg.remindersEnabled && !force) return { tickets: 0, recipients: 0 };
    const group = STAGE_GROUP[stage];
    const members = group ? cfg.approvers[group] : [];

    const tickets = await this.prisma.priceChangeTicket.findMany({
      where: { stage },
      orderBy: { stageEnteredAt: 'asc' },
      select: {
        code: true,
        hasCost: true,
        hasSale: true,
        stageEnteredAt: true,
        items: {
          orderBy: { sort: 'asc' },
          select: { productCode: true, productName: true },
        },
      },
    });
    if (!tickets.length || !members.length)
      return { tickets: tickets.length, recipients: 0 };

    const now = new Date();
    const sent = await this.notify.sendReminder(
      stage,
      members,
      tickets.map((t) => ({
        code: t.code,
        hasCost: t.hasCost,
        hasSale: t.hasSale,
        itemCount: t.items.length,
        firstProduct: t.items[0]
          ? `${t.items[0].productCode} ${t.items[0].productName}`.trim()
          : null,
        days: daysSince(t.stageEnteredAt, now),
      })),
      now.toLocaleDateString('sv-SE', { timeZone: TZ }),
    );
    this.logger.log(
      `Nhắc việc thay đổi giá ${stage}: ${tickets.length} phiếu, ${sent.length} người nhận`,
    );
    return { tickets: tickets.length, recipients: sent.length };
  }
}
