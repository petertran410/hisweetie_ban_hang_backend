import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MANUFACTURED_PARENT,
  NPP_GROUP,
  NPP_STAGE,
  NPP_STATUS,
  NppStage,
  STAGE_GROUP,
} from './new-product-price.constants';
import { leadtimeDays } from './new-product-price.calc';
import { NewProductPriceConfigService } from './new-product-price-config.service';
import { NewProductPriceNotifyService } from './new-product-price-notify.service';

const TZ = 'Asia/Ho_Chi_Minh';

/** Nhắc việc hằng ngày (thay 4 workflow "Nhắc Task …" trên Lark). */
@Injectable()
export class NewProductPriceReminderCron {
  private readonly logger = new Logger(NewProductPriceReminderCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nppConfig: NewProductPriceConfigService,
    private readonly notify: NewProductPriceNotifyService,
  ) {}

  @Cron('0 17 * * *', { name: 'new-product-price-reminder-17h', timeZone: TZ })
  async remindAt17() {
    await this.runStages([
      NPP_STAGE.PURCHASING,
      NPP_STAGE.SALES,
      NPP_STAGE.CEO,
    ]);
  }

  @Cron('0 16 * * *', { name: 'new-product-price-reminder-16h', timeZone: TZ })
  async remindAt16() {
    await this.runStages([NPP_STAGE.ACCOUNTING]);
  }

  async runStages(stages: NppStage[], force = false) {
    const out: Record<string, { tickets: number; recipients: number }> = {};
    for (const stage of stages) {
      try {
        out[stage] = await this.runStage(stage, force);
      } catch (err: any) {
        this.logger.error(`Nhắc việc ${stage} lỗi: ${err?.message}`);
        out[stage] = { tickets: 0, recipients: 0 };
      }
    }
    return out;
  }

  private async runStage(stage: NppStage, force: boolean) {
    const cfg = await this.nppConfig.get();
    if (!cfg.remindersEnabled && !force) return { tickets: 0, recipients: 0 };

    const where: Prisma.NewProductPriceTicketWhereInput = {
      stage,
      status: NPP_STATUS.UNDER_REVIEW,
    };
    if (stage === NPP_STAGE.SALES) {
      // Lark: nhắc Phòng Kinh Doanh bỏ qua Hàng sản xuất.
      where.OR = [
        { parentName: null },
        {
          NOT: {
            parentName: { equals: MANUFACTURED_PARENT, mode: 'insensitive' },
          },
        },
      ];
    }
    const tickets = await this.prisma.newProductPriceTicket.findMany({
      where,
      orderBy: { stageEnteredAt: 'asc' },
      select: {
        code: true,
        productName: true,
        createdAt: true,
        stageEnteredAt: true,
        costApproverId: true,
      },
    });
    if (!tickets.length) return { tickets: 0, recipients: 0 };

    const now = new Date();
    const dateKey = now.toLocaleDateString('sv-SE', { timeZone: TZ });
    const item = (t: (typeof tickets)[number]) => ({
      code: t.code,
      productName: t.productName,
      days: leadtimeDays({ createdAt: t.stageEnteredAt }, now),
    });

    const group = STAGE_GROUP[stage];
    const members = group ? cfg.approvers[group] : [];
    // Thu Mua: người duyệt giá cost (ngoài nhóm) nhận riêng các phiếu của mình.
    const byApprover = new Map<number, typeof tickets>();
    if (stage === NPP_STAGE.PURCHASING) {
      for (const t of tickets) {
        if (
          !t.costApproverId ||
          cfg.approvers[NPP_GROUP.PURCHASING].includes(t.costApproverId)
        ) {
          continue;
        }
        byApprover.set(t.costApproverId, [
          ...(byApprover.get(t.costApproverId) ?? []),
          t,
        ]);
      }
    }

    let recipients = 0;
    if (members.length) {
      const sent = await this.notify.sendReminder(
        stage,
        members,
        tickets.map(item),
        dateKey,
      );
      recipients += sent.length;
    }
    for (const [userId, list] of byApprover) {
      const sent = await this.notify.sendReminder(
        stage,
        [userId],
        list.map(item),
        dateKey,
      );
      recipients += sent.length;
    }

    this.logger.log(
      `Nhắc việc ${stage}: ${tickets.length} phiếu, ${recipients} người nhận`,
    );
    return { tickets: tickets.length, recipients };
  }
}
