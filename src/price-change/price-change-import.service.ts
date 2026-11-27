import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import {
  LarkAttachment,
  fieldOf,
  foldText,
  larkAttachments,
  larkDate,
  larkDecision,
  larkLinks,
  larkText,
  larkUser,
} from '../new-product-price/new-product-price-lark-mapping';
import {
  BASE_PRICE_BOOK_ID,
  BASE_PRICE_BOOK_NAME,
  CODE_PREFIX,
  CostLine,
  PC_EVENT,
  PC_STAGE,
  PcStage,
  PriceLine,
  UPLOAD_SUBFOLDER,
} from './price-change.constants';
import { computeStatus } from './price-change.rules';
import {
  FLOW_FIELD,
  extractLarkChanges,
  inferStage,
  larkCeoDecision,
  matchByName,
  matchPriceBook,
} from './price-change-lark-mapping';
import { PriceChangeReferenceService } from './price-change-reference.service';
import { PcLarkImportDto } from './dto';

const LARK_HOST = 'https://open.larksuite.com';
/** Base "2SVN" + bảng "Thay Đổi Giá Sản Phẩm" (ghi đè bằng env khi cần). */
const DEFAULT_BASE_TOKEN = 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
const DEFAULT_TABLE_ID = 'tblF5yJ4X7JbVb9c';

interface StoredAttachment {
  url: string;
  originalName: string | null;
  mimetype: string | null;
  size: number | null;
  larkFileToken: string;
}

export interface PcImportResult {
  dryRun: boolean;
  totalFetched: number;
  created: number;
  updated: number;
  skippedEditedInPos: number;
  byStage: Record<string, number>;
  unmatched: Record<string, string[]>;
  media: { downloaded: number; skippedExisting: number; failed: number };
  errors: { recordId: string; message: string }[];
}

interface Lookups {
  branches: { id: number; name: string }[];
  priceBooks: { id: number; name: string }[];
  usersByOpenId: Map<string, { id: number; name: string }>;
  usersByName: Map<string, { id: number; name: string }[]>;
  productsByLark: Map<string, { id: number; code: string; name: string }>;
  productsByCode: Map<string, { id: number; code: string; name: string }>;
}

interface MappedRecord {
  stage: PcStage;
  data: Record<string, unknown>;
  item: {
    productId: number | null;
    productCode: string;
    productName: string;
    costs: { branchId: number; branchName: string; newCost: number }[];
    prices: { priceBookId: number; priceBookName: string; newPrice: number }[];
  } | null;
}

/** Nhập bảng "Thay Đổi Giá Sản Phẩm" từ Lark Base (idempotent theo record id). */
@Injectable()
export class PriceChangeImportService {
  private readonly logger = new Logger(PriceChangeImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly upload: UploadService,
    private readonly reference: PriceChangeReferenceService,
    @Optional() @Inject(LARK_CLIENT) private readonly larkClient?: lark.Client,
  ) {}

  private async token(): Promise<string> {
    if (!this.larkClient)
      throw new BadRequestException('Chưa cấu hình Lark (LARK_APP_ID/SECRET)');
    return this.larkClient.tokenManager.getTenantAccessToken();
  }

  private async getJson(path: string, token: string): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${LARK_HOST}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      // 99991400 = vượt giới hạn tần suất → nghỉ rồi thử lại.
      if (body?.code === 99991400 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return body;
    }
    throw new Error('Lark giới hạn tần suất, vui lòng thử lại sau');
  }

  /** Bản ghi qua bitable v1 + trường Flow "Đề Xuất" qua Base v3 (v1 không trả Flow). */
  private async fetchRecords(
    base: string,
    table: string,
    token: string,
    limit?: number,
  ) {
    const records: any[] = [];
    let pageToken: string | undefined;
    do {
      const size = Math.min(500, limit ? limit - records.length : 500);
      if (size <= 0) break;
      const qs = new URLSearchParams({
        page_size: String(size),
        automatic_fields: 'true',
      });
      if (pageToken) qs.set('page_token', pageToken);
      const res = await this.getJson(
        `/open-apis/bitable/v1/apps/${base}/tables/${table}/records?${qs}`,
        token,
      );
      if (res.code !== 0)
        throw new BadRequestException(`Lark: ${res.msg || res.code}`);
      records.push(...(res.data?.items ?? []));
      pageToken = res.data?.has_more ? res.data?.page_token : undefined;
    } while (pageToken);

    const flow = new Map<string, unknown>();
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        field_id: FLOW_FIELD,
        limit: '200',
        offset: String(offset),
      });
      const res = await this.getJson(
        `/open-apis/base/v3/bases/${base}/tables/${table}/records?${qs}`,
        token,
      );
      if (res.code !== 0) {
        this.logger.warn(
          `Không đọc được "${FLOW_FIELD}" (Base v3): ${res.msg}`,
        );
        break;
      }
      const page = res.data ?? {};
      const names: string[] = Array.isArray(page.fields) ? page.fields : [];
      const idx = names.indexOf(FLOW_FIELD);
      const rows: any[][] = Array.isArray(page.data) ? page.data : [];
      const ids: string[] = Array.isArray(page.record_id_list)
        ? page.record_id_list
        : [];
      rows.forEach((row, i) => {
        if (ids[i] && idx >= 0) flow.set(ids[i], row?.[idx] ?? null);
      });
      if (!page.has_more || rows.length === 0) break;
      offset += rows.length;
    }
    for (const r of records) {
      if (flow.has(r.record_id))
        r.fields = { ...(r.fields ?? {}), [FLOW_FIELD]: flow.get(r.record_id) };
    }
    return records;
  }

  private async loadLookups(): Promise<Lookups> {
    const [branches, priceBooks, users, products] = await Promise.all([
      this.prisma.branch.findMany({ select: { id: true, name: true } }),
      this.prisma.priceBook.findMany({
        select: { id: true, name: true, isActive: true },
        orderBy: { isActive: 'desc' },
      }),
      this.prisma.user.findMany({
        select: { id: true, name: true, larkUserId: true },
      }),
      this.prisma.product.findMany({
        select: { id: true, code: true, name: true, larkRecordId: true },
      }),
    ]);
    const usersByName = new Map<string, { id: number; name: string }[]>();
    for (const u of users) {
      const k = foldText(u.name);
      if (k) usersByName.set(k, [...(usersByName.get(k) ?? []), u]);
    }
    return {
      branches,
      // Bảng giá đang dùng đứng trước → tên trùng thì khớp bản đang dùng.
      priceBooks: priceBooks.filter(
        (p, i, all) =>
          all.findIndex((x) => foldText(x.name) === foldText(p.name)) === i,
      ),
      usersByOpenId: new Map(
        users
          .filter((u) => u.larkUserId)
          .map((u) => [u.larkUserId!, { id: u.id, name: u.name }]),
      ),
      usersByName,
      productsByLark: new Map(
        products.filter((p) => p.larkRecordId).map((p) => [p.larkRecordId!, p]),
      ),
      productsByCode: new Map(products.map((p) => [p.code.toUpperCase(), p])),
    };
  }

  /** Bản ghi Lark → dữ liệu phiếu + 1 dòng sản phẩm. */
  private mapRecord(
    record: any,
    lk: Lookups,
    unmatched: Record<string, Set<string>>,
  ): MappedRecord {
    const f: Record<string, unknown> = record.fields ?? {};
    const miss = (key: string, value: string) => {
      if (!value) return;
      (unmatched[key] ??= new Set()).add(value);
    };
    const notes: { field: string; value: string }[] = [];

    // Sản phẩm: liên kết bản ghi Sản Phẩm (larkRecordId) → mã hàng tra cứu.
    const link = larkLinks(fieldOf(f, 'Mã Hàng Hoá', 'Mã Hàng Hóa'))[0];
    const codeText =
      larkText(fieldOf(f, 'Mã Hàng')).split(',')[0]?.trim() ?? '';
    const product =
      (link?.recordId ? lk.productsByLark.get(link.recordId) : undefined) ??
      (codeText ? lk.productsByCode.get(codeText.toUpperCase()) : undefined);
    const larkName = larkText(fieldOf(f, 'Tên Hàng Hoá', 'Tên Hàng Hóa'));
    if (!product) {
      miss('Sản phẩm', codeText || link?.text || larkName || record.record_id);
      notes.push({ field: 'Sản phẩm', value: codeText || larkName });
    }

    const changes = extractLarkChanges(f);
    const costs: NonNullable<MappedRecord['item']>['costs'] = [];
    for (const c of changes.costs) {
      const branch = matchByName(c.name, lk.branches);
      if (!branch) {
        miss('Chi nhánh', c.name);
        notes.push({ field: `Giá vốn ${c.name}`, value: String(c.value) });
        continue;
      }
      costs.push({
        branchId: branch.id,
        branchName: branch.name,
        newCost: c.value,
      });
    }
    const prices: NonNullable<MappedRecord['item']>['prices'] = [];
    for (const p of changes.prices) {
      const id = matchPriceBook(p.name, lk.priceBooks);
      if (id === null) {
        miss('Bảng giá', p.name);
        notes.push({ field: p.name, value: String(p.value) });
        continue;
      }
      const name =
        id === BASE_PRICE_BOOK_ID
          ? BASE_PRICE_BOOK_NAME
          : (lk.priceBooks.find((b) => b.id === id)?.name ?? p.name);
      prices.push({ priceBookId: id, priceBookName: name, newPrice: p.value });
    }
    const hasCost = costs.length > 0;
    const hasSale = prices.length > 0;

    const ktt = larkDecision(fieldOf(f, 'Kế Toán Trưởng Duyệt Giá Vốn'));
    const ceo = larkCeoDecision(f, hasCost, fieldOf);
    const flow = larkText(fieldOf(f, FLOW_FIELD));
    const stage = inferStage({ flow, hasCost, ktt, ceo });

    const proposer =
      larkUser(fieldOf(f, 'Người Đề Xuất')) ?? larkUser(record.created_by);
    let createdBy: { id: number; name: string } | null = null;
    if (proposer) {
      createdBy =
        (proposer.openId && lk.usersByOpenId.get(proposer.openId)) ||
        (lk.usersByName.get(foldText(proposer.name))?.length === 1
          ? lk.usersByName.get(foldText(proposer.name))![0]
          : null);
      if (!createdBy) miss('Người đề xuất', proposer.name);
    }
    const createdAt =
      larkDate(fieldOf(f, 'Thời Gian Tạo')) ??
      (record.created_time ? new Date(record.created_time) : new Date());
    const modifiedAt =
      larkDate(fieldOf(f, 'Thời Gian Cập Nhật')) ??
      (record.last_modified_time
        ? new Date(record.last_modified_time)
        : createdAt);

    const data: Record<string, unknown> = {
      stage,
      status: computeStatus({ stage, kttDecision: ktt, ceoDecision: ceo }),
      stageEnteredAt: stage === PC_STAGE.PROPOSAL ? createdAt : modifiedAt,
      hasCost,
      hasSale,
      costBranchIds: [...new Set(costs.map((c) => c.branchId))],
      priceBookIds: [...new Set(prices.map((p) => p.priceBookId))],
      kttDecision: ktt,
      ceoDecision: ceo,
      note: larkText(fieldOf(f, 'Ghi chú')) || null,
      importNotes: notes.length ? notes : Prisma.DbNull,
      doneAt: stage === PC_STAGE.DONE ? modifiedAt : null,
      endedAt: stage === PC_STAGE.ENDED ? modifiedAt : null,
      endReason: stage === PC_STAGE.ENDED ? 'Bị từ chối trên Lark' : null,
      createdById: createdBy?.id ?? null,
      createdByName: createdBy?.name ?? proposer?.name ?? null,
      createdAt,
    };

    const productCode = product?.code ?? (codeText || link?.text || '—');
    return {
      stage,
      data,
      item:
        product || codeText || link?.text
          ? {
              productId: product?.id ?? null,
              productCode,
              productName: product?.name ?? (larkName || productCode),
              costs,
              prices,
            }
          : null,
    };
  }

  /** Giá cũ: phiếu đã xong / kết thúc để trống (cột tra cứu Lark luôn là giá hiện tại). */
  private async itemRow(ticketId: number, mapped: MappedRecord) {
    const item = mapped.item!;
    const open =
      mapped.stage !== PC_STAGE.DONE && mapped.stage !== PC_STAGE.ENDED;
    const current =
      open && item.productId
        ? (
            await this.reference.currentValues(
              [item.productId],
              item.costs.map((c) => c.branchId),
              item.prices.map((p) => p.priceBookId),
            )
          )[0]
        : undefined;
    const costs: CostLine[] = item.costs.map((c) => ({
      branchId: c.branchId,
      branchName: c.branchName,
      oldCost: current?.costs[c.branchId] ?? null,
      newCost: c.newCost,
    }));
    const prices: PriceLine[] = item.prices.map((p) => ({
      priceBookId: p.priceBookId,
      priceBookName: p.priceBookName,
      oldPrice: current?.prices[p.priceBookId] ?? null,
      newPrice: p.newPrice,
    }));
    return {
      ticketId,
      sort: 0,
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      costs: costs as unknown as Prisma.InputJsonValue,
      prices: prices as unknown as Prisma.InputJsonValue,
    };
  }

  private async downloadAll(
    items: LarkAttachment[],
    existing: StoredAttachment[],
    token: string,
    stats: PcImportResult['media'],
  ): Promise<StoredAttachment[]> {
    const have = new Map(existing.map((a) => [a.larkFileToken, a]));
    const out: StoredAttachment[] = [];
    for (const item of items) {
      const prev = have.get(item.file_token);
      if (prev) {
        out.push(prev);
        stats.skippedExisting++;
        continue;
      }
      const url = item.url || item.tmp_url;
      if (!url) {
        stats.failed++;
        continue;
      }
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const name = item.name || item.file_token;
        const mime = item.type || 'application/octet-stream';
        const saved = await this.upload.saveFile(
          buffer,
          name,
          mime,
          UPLOAD_SUBFOLDER,
        );
        out.push({
          url: saved.url,
          originalName: name,
          mimetype: mime,
          size: saved.size,
          larkFileToken: item.file_token,
        });
        stats.downloaded++;
        await new Promise((r) => setTimeout(r, 120)); // giới hạn ~5 QPS của Lark
      } catch (err: any) {
        stats.failed++;
        this.logger.warn(
          `Tải ${item.name || item.file_token} lỗi: ${err?.message}`,
        );
      }
    }
    return out;
  }

  async run(
    dto: PcLarkImportDto,
    actor: { id: number; name?: string },
  ): Promise<PcImportResult> {
    const base =
      dto.baseToken ||
      this.config.get<string>('LARK_PRICE_CHANGE_BASE_TOKEN') ||
      DEFAULT_BASE_TOKEN;
    const table =
      dto.tableId ||
      this.config.get<string>('LARK_PRICE_CHANGE_TABLE_ID') ||
      DEFAULT_TABLE_ID;
    const dryRun = dto.dryRun !== false;
    const token = await this.token();
    const records = await this.fetchRecords(base, table, token, dto.limit);
    // Sinh mã TDG theo thứ tự thời gian tạo trên Lark.
    records.sort((a, b) => (a.created_time ?? 0) - (b.created_time ?? 0));

    const lk = await this.loadLookups();
    const unmatchedSets: Record<string, Set<string>> = {};
    const result: PcImportResult = {
      dryRun,
      totalFetched: records.length,
      created: 0,
      updated: 0,
      skippedEditedInPos: 0,
      byStage: {},
      unmatched: {},
      media: { downloaded: 0, skippedExisting: 0, failed: 0 },
      errors: [],
    };

    const existingRows = await this.prisma.priceChangeTicket.findMany({
      where: { sourceRecordId: { in: records.map((r) => r.record_id) } },
      select: {
        id: true,
        sourceRecordId: true,
        updatedAt: true,
        lastImportedAt: true,
        documents: true,
      },
    });
    const existing = new Map(existingRows.map((r) => [r.sourceRecordId!, r]));
    const last = await this.prisma.priceChangeTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let nextNum = last
      ? parseInt(last.code.slice(CODE_PREFIX.length), 10) || 0
      : 0;

    for (const record of records) {
      try {
        const mapped = this.mapRecord(record, lk, unmatchedSets);
        result.byStage[mapped.stage] = (result.byStage[mapped.stage] ?? 0) + 1;
        const prev = existing.get(record.record_id);
        if (
          prev &&
          !dto.force &&
          prev.lastImportedAt &&
          prev.updatedAt.getTime() > prev.lastImportedAt.getTime() + 1000
        ) {
          result.skippedEditedInPos++;
          continue;
        }
        if (dryRun) {
          if (prev) result.updated++;
          else result.created++;
          continue;
        }

        const media: Record<string, unknown> = {};
        if (dto.downloadMedia) {
          const docs = await this.downloadAll(
            larkAttachments(fieldOf(record.fields ?? {}, 'Tài Liệu')),
            (prev?.documents as unknown as StoredAttachment[]) ?? [],
            token,
            result.media,
          );
          media.documents = docs.length ? docs : Prisma.DbNull;
        }

        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          let ticketId: number;
          if (prev) {
            await tx.priceChangeTicket.update({
              where: { id: prev.id },
              data: {
                ...(mapped.data as any),
                ...media,
                lastImportedAt: now,
                updatedById: actor.id,
                updatedByName: actor.name ?? null,
              },
            });
            ticketId = prev.id;
            await tx.priceChangeItem.deleteMany({ where: { ticketId } });
            result.updated++;
          } else {
            nextNum += 1;
            const created = await tx.priceChangeTicket.create({
              data: {
                ...(mapped.data as any),
                ...media,
                code: `${CODE_PREFIX}${String(nextNum).padStart(6, '0')}`,
                sourceRecordId: record.record_id,
                lastImportedAt: now,
                updatedById: actor.id,
                updatedByName: actor.name ?? null,
              },
            });
            ticketId = created.id;
            result.created++;
          }
          if (mapped.item) {
            await tx.priceChangeItem.create({
              data: await this.itemRow(ticketId, mapped),
            });
          }
          await tx.priceChangeEvent.create({
            data: {
              ticketId,
              type: PC_EVENT.IMPORTED,
              toStage: mapped.stage,
              content: prev ? 'Cập nhật từ Lark Base' : 'Nhập từ Lark Base',
              data: { recordId: record.record_id },
              actorId: actor.id,
              actorName: actor.name ?? null,
            },
          });
        });
      } catch (err: any) {
        result.errors.push({
          recordId: record.record_id,
          message: String(err?.message || err).slice(0, 300),
        });
      }
    }

    for (const [k, set] of Object.entries(unmatchedSets))
      result.unmatched[k] = [...set].sort();
    this.logger.log(
      `Nhập Lark thay đổi giá: ${records.length} bản ghi, tạo ${result.created}, cập nhật ${result.updated}, dryRun=${dryRun}`,
    );
    return result;
  }
}
