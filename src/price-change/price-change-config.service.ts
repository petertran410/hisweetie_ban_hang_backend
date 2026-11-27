import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseLarkAllowlist } from '../lark-sync/lark-message-guard';
import { PC_GROUPS, PcGroup } from './price-change.constants';
import { PcConfigDto } from './dto';

export interface PcConfig {
  approvers: Record<PcGroup, number[]>;
  /** Gửi thử: khác rỗng → mọi thông báo (trong app + Lark) chỉ gửi tới những người này. */
  testRecipients: number[];
  /** Local/dev có LARK_MESSAGE_ALLOWLIST → luôn gửi thử tới người trong danh sách, không tắt được. */
  testLocked: boolean;
  updatedAt: Date | null;
  updatedByName: string | null;
}

const CONFIG_ID = 1;

function asRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  ];
}

/** Cấu hình người duyệt + gửi thử của luồng thay đổi giá (1 dòng id=1). */
@Injectable()
export class PriceChangeConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
  ) {}

  private async allowlistUserIds(): Promise<number[] | null> {
    const allow = parseLarkAllowlist(
      this.env.get<string>('LARK_MESSAGE_ALLOWLIST'),
    );
    if (!allow) return null;
    const users = await this.prisma.user.findMany({
      where: { larkUserId: { in: [...allow] }, isActive: true },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async get(): Promise<PcConfig> {
    const row = await this.prisma.priceChangeConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    const raw = asRecord(row?.approvers);
    const approvers = {} as Record<PcGroup, number[]>;
    for (const g of PC_GROUPS) approvers[g] = toIds(raw[g]);
    const locked = await this.allowlistUserIds();
    return {
      approvers,
      testRecipients: locked ?? toIds(row?.testRecipients),
      testLocked: locked !== null,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  }

  async update(dto: PcConfigDto, actor: { id: number; name?: string }) {
    const current = await this.get();
    const approvers = {} as Record<PcGroup, number[]>;
    for (const g of PC_GROUPS) {
      approvers[g] = dto.approvers
        ? toIds(dto.approvers[g])
        : current.approvers[g];
    }
    const testRecipients =
      dto.testRecipients !== undefined
        ? toIds(dto.testRecipients)
        : current.testRecipients;

    const allIds = new Set<number>([
      ...PC_GROUPS.flatMap((g) => approvers[g]),
      ...testRecipients,
    ]);
    if (allIds.size) {
      const found = await this.prisma.user.count({
        where: { id: { in: [...allIds] } },
      });
      if (found !== allIds.size)
        throw new BadRequestException('Có người nhận không tồn tại');
    }

    const data = {
      approvers,
      testRecipients,
      updatedById: actor.id,
      updatedByName: actor.name ?? null,
    };
    await this.prisma.priceChangeConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data },
      update: data,
    });
    return this.get();
  }
}
