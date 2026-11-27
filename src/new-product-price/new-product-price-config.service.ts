import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePriceBookName } from '../lark-sync/helpers/product-field-mapping';
import { parseLarkAllowlist } from '../lark-sync/lark-message-guard';
import {
  BASE_PRICE_TARGET,
  COST_GROUP_KEYS,
  CostGroupKey,
  DEFAULT_COST_BRANCH_KEYWORDS,
  DEFAULT_PRICE_TARGET_NAMES,
  NPP_GROUPS,
  NppGroup,
  PRICE_TARGET_KEYS,
  PriceTargetKey,
} from './new-product-price.constants';
import { NppConfigDto } from './dto';

export type PriceTarget = typeof BASE_PRICE_TARGET | number | null;

export interface NppConfig {
  approvers: Record<NppGroup, number[]>;
  priceTargets: Record<PriceTargetKey, PriceTarget>;
  costBranches: Record<CostGroupKey, number[]>;
  larkChatId: string | null;
  remindersEnabled: boolean;
  /**
   * Gửi thử: khác rỗng → MỌI thông báo (trong app + Lark + nhắc việc) chỉ gửi tới
   * những người này thay cho người nhận thật; không gửi nhóm chat.
   */
  testRecipients: number[];
  /**
   * true = môi trường có LARK_MESSAGE_ALLOWLIST (local/dev): luôn gửi thử tới người
   * trong danh sách đó, không tắt được trên giao diện.
   */
  testLocked: boolean;
  /** Các mục đang dùng giá trị dò mặc định (chưa lưu cấu hình). */
  defaults: { priceTargets: PriceTargetKey[]; costBranches: CostGroupKey[] };
  updatedAt: Date | null;
  updatedByName: string | null;
}

const CONFIG_ID = 1;
/** Khóa trong JSON `approvers` lưu danh sách người nhận khi gửi thử. */
const TEST_RECIPIENTS_KEY = 'TEST_RECIPIENTS';

function asRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function toIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  ];
}

function strip(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

@Injectable()
export class NewProductPriceConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
  ) {}

  /** User có lark_user_id nằm trong LARK_MESSAGE_ALLOWLIST (null = không giới hạn). */
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

  /** Cấu hình đã chuẩn hóa; mục chưa lưu thì dò mặc định theo tên bảng giá / chi nhánh. */
  async get(): Promise<NppConfig> {
    const row = await this.prisma.newProductPriceConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    const approversRaw = asRecord(row?.approvers);
    const targetsRaw = asRecord(row?.priceTargets);
    const branchesRaw = asRecord(row?.costBranches);

    const approvers = {} as Record<NppGroup, number[]>;
    for (const g of NPP_GROUPS) approvers[g] = toIds(approversRaw[g]);

    const defaults: NppConfig['defaults'] = {
      priceTargets: [],
      costBranches: [],
    };
    const missingTargets = PRICE_TARGET_KEYS.filter((k) => !(k in targetsRaw));
    const missingBranches = COST_GROUP_KEYS.filter((k) => !(k in branchesRaw));

    const [priceBooks, branches] = await Promise.all([
      missingTargets.length
        ? this.prisma.priceBook.findMany({
            where: { isActive: true },
            select: { id: true, name: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([] as { id: number; name: string }[]),
      missingBranches.length
        ? this.prisma.branch.findMany({
            where: { isActive: true },
            select: { id: true, name: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([] as { id: number; name: string }[]),
    ]);

    const priceTargets = {} as Record<PriceTargetKey, PriceTarget>;
    for (const key of PRICE_TARGET_KEYS) {
      if (key in targetsRaw) {
        priceTargets[key] = this.parseTarget(targetsRaw[key]);
        continue;
      }
      const wanted = DEFAULT_PRICE_TARGET_NAMES[key];
      if (wanted === BASE_PRICE_TARGET) {
        priceTargets[key] = BASE_PRICE_TARGET;
      } else {
        const norm = normalizePriceBookName(wanted);
        const found = priceBooks.find(
          (pb) => normalizePriceBookName(pb.name) === norm,
        );
        priceTargets[key] = found ? found.id : null;
      }
      defaults.priceTargets.push(key);
    }

    const costBranches = {} as Record<CostGroupKey, number[]>;
    for (const key of COST_GROUP_KEYS) {
      if (key in branchesRaw) {
        costBranches[key] = toIds(branchesRaw[key]);
        continue;
      }
      const keywords = DEFAULT_COST_BRANCH_KEYWORDS[key].map(strip);
      costBranches[key] = branches
        .filter((b) => keywords.some((kw) => strip(b.name).includes(kw)))
        .map((b) => b.id);
      defaults.costBranches.push(key);
    }
    // Chi nhánh Diệp Trà thường cũng chứa "Hà Nội"/"Sài Gòn" → không tính 2 lần.
    if (defaults.costBranches.length) {
      const dt = new Set(costBranches.DT);
      for (const key of ['HN', 'SG'] as CostGroupKey[]) {
        if (defaults.costBranches.includes(key)) {
          costBranches[key] = costBranches[key].filter((id) => !dt.has(id));
        }
      }
    }

    // Local/dev (có LARK_MESSAGE_ALLOWLIST): luôn gửi thử, chỉ tới người trong danh sách.
    const locked = await this.allowlistUserIds();
    return {
      approvers,
      priceTargets,
      costBranches,
      larkChatId: row?.larkChatId ?? null,
      remindersEnabled: row?.remindersEnabled ?? true,
      testRecipients: locked ?? toIds(approversRaw[TEST_RECIPIENTS_KEY]),
      testLocked: locked !== null,
      defaults,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  }

  private parseTarget(value: unknown): PriceTarget {
    if (value === BASE_PRICE_TARGET) return BASE_PRICE_TARGET;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  async update(dto: NppConfigDto, actor: { id: number; name?: string }) {
    const current = await this.get();
    const data: Prisma.NewProductPriceConfigUpdateInput = {
      updatedById: actor.id,
      updatedByName: actor.name ?? null,
    };

    // Nhóm người duyệt + danh sách gửi thử cùng nằm trong JSON `approvers`.
    if (dto.approvers || dto.testRecipients !== undefined) {
      const approvers = {} as Record<string, number[]>;
      const allIds = new Set<number>();
      for (const g of NPP_GROUPS) {
        approvers[g] = dto.approvers
          ? toIds(dto.approvers[g])
          : current.approvers[g];
        approvers[g].forEach((id) => allIds.add(id));
      }
      approvers[TEST_RECIPIENTS_KEY] =
        dto.testRecipients !== undefined
          ? toIds(dto.testRecipients)
          : current.testRecipients;
      approvers[TEST_RECIPIENTS_KEY].forEach((id) => allIds.add(id));
      if (allIds.size) {
        const found = await this.prisma.user.count({
          where: { id: { in: [...allIds] } },
        });
        if (found !== allIds.size) {
          throw new BadRequestException('Có người nhận không tồn tại');
        }
      }
      data.approvers = approvers;
    }

    if (dto.priceTargets) {
      const targets = {} as Record<string, PriceTarget>;
      const ids = new Set<number>();
      for (const key of PRICE_TARGET_KEYS) {
        const raw =
          key in dto.priceTargets
            ? dto.priceTargets[key]
            : current.priceTargets[key];
        const t = this.parseTarget(raw);
        targets[key] = t;
        if (typeof t === 'number') ids.add(t);
      }
      if (ids.size) {
        const found = await this.prisma.priceBook.count({
          where: { id: { in: [...ids] } },
        });
        if (found !== ids.size) {
          throw new BadRequestException('Có bảng giá đích không tồn tại');
        }
      }
      data.priceTargets = targets;
    }

    if (dto.costBranches) {
      const groups = {} as Record<string, number[]>;
      const seen = new Map<number, string>();
      for (const key of COST_GROUP_KEYS) {
        const ids = toIds(
          key in dto.costBranches
            ? dto.costBranches[key]
            : current.costBranches[key],
        );
        for (const id of ids) {
          if (seen.has(id)) {
            throw new BadRequestException(
              'Một chi nhánh chỉ được thuộc một nhóm giá vốn (HN / SG / Diệp Trà)',
            );
          }
          seen.set(id, key);
        }
        groups[key] = ids;
      }
      if (seen.size) {
        const found = await this.prisma.branch.count({
          where: { id: { in: [...seen.keys()] } },
        });
        if (found !== seen.size)
          throw new BadRequestException('Có chi nhánh không tồn tại');
      }
      data.costBranches = groups;
    }

    if (dto.larkChatId !== undefined)
      data.larkChatId = dto.larkChatId?.trim() || null;
    if (dto.remindersEnabled !== undefined)
      data.remindersEnabled = dto.remindersEnabled;

    await this.prisma.newProductPriceConfig.upsert({
      where: { id: CONFIG_ID },
      create: {
        id: CONFIG_ID,
        approvers: (data.approvers as any) ?? {
          ...current.approvers,
          [TEST_RECIPIENTS_KEY]: current.testRecipients,
        },
        priceTargets: (data.priceTargets as any) ?? current.priceTargets,
        costBranches: (data.costBranches as any) ?? current.costBranches,
        larkChatId:
          (data.larkChatId as string | null | undefined) ?? current.larkChatId,
        remindersEnabled:
          (data.remindersEnabled as boolean | undefined) ??
          current.remindersEnabled,
        updatedById: actor.id,
        updatedByName: actor.name ?? null,
      },
      update: data,
    });
    return this.get();
  }
}
