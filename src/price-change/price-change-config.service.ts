import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PC_GROUPS, PcGroup } from './price-change.constants';
import { PcConfigDto } from './dto';

export interface PcConfig {
  approvers: Record<PcGroup, number[]>;
  /** Nhóm Lark dạng topic: mỗi phiếu 1 topic, mỗi bước trả lời trong topic + tag người phụ trách. */
  larkChatId: string | null;
  /** Nhắc việc hằng ngày (17:00) cho Kế toán trưởng, CEO, Phòng Dữ Liệu — mặc định bật. */
  remindersEnabled: boolean;
  updatedAt: Date | null;
  updatedByName: string | null;
}

const CONFIG_ID = 1;
/** chat_id nhóm & cờ nhắc việc lưu chung cột JSON `approvers` (khóa riêng) để không phải thêm cột DB. */
const CHAT_KEY = 'larkChatId';
const REMIND_KEY = 'remindersEnabled';
const CHAT_ID_RE = /^oc_[A-Za-z0-9]+$/;

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

function toChatId(value: unknown): string | null {
  return typeof value === 'string' && CHAT_ID_RE.test(value.trim())
    ? value.trim()
    : null;
}

/**
 * Người duyệt từng bước + nhóm Lark của luồng thay đổi giá (1 dòng id=1). Không có chế độ gửi thử:
 * máy local chặn tin Lark tới người / nhóm ngoài LARK_MESSAGE_ALLOWLIST (lark-message-guard).
 */
@Injectable()
export class PriceChangeConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<PcConfig> {
    const row = await this.prisma.priceChangeConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    const raw = asRecord(row?.approvers);
    const approvers = {} as Record<PcGroup, number[]>;
    for (const g of PC_GROUPS) approvers[g] = toIds(raw[g]);
    return {
      approvers,
      larkChatId: toChatId(raw[CHAT_KEY]),
      remindersEnabled: raw[REMIND_KEY] !== false,
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
    const allIds = new Set<number>(PC_GROUPS.flatMap((g) => approvers[g]));
    if (allIds.size) {
      const found = await this.prisma.user.count({
        where: { id: { in: [...allIds] } },
      });
      if (found !== allIds.size)
        throw new BadRequestException('Có người nhận không tồn tại');
    }

    let larkChatId = current.larkChatId;
    if (dto.larkChatId !== undefined) {
      const value = (dto.larkChatId ?? '').trim();
      if (value && !CHAT_ID_RE.test(value))
        throw new BadRequestException(
          'chat_id nhóm Lark không hợp lệ (dạng oc_…)',
        );
      larkChatId = value || null;
    }

    const remindersEnabled = dto.remindersEnabled ?? current.remindersEnabled;

    const data = {
      approvers: {
        ...approvers,
        ...(larkChatId ? { [CHAT_KEY]: larkChatId } : {}),
        [REMIND_KEY]: remindersEnabled,
      },
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
