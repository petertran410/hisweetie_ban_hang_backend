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
import { normalizePriceBookName } from '../lark-sync/helpers/product-field-mapping';
import { loadUnitNameMap, resolveUnitFromMap } from '../common/unit.util';
import {
  CODE_PREFIX,
  NPP_EVENT,
  NPP_STAGE,
  NppStage,
  UPLOAD_SUBFOLDER,
} from './new-product-price.constants';
import { computeStatus } from './new-product-price.rules';
import {
  LarkAttachment,
  fieldOf,
  foldText,
  larkAttachments,
  larkBool,
  larkDate,
  larkDecision,
  larkLinks,
  larkNumber,
  larkStage,
  larkText,
  larkUrl,
  larkUser,
} from './new-product-price-lark-mapping';
import { NppLarkImportDto } from './dto';

const LARK_HOST = 'https://open.larksuite.com';
/** Base "2SVN" + bảng "Bảng Giá Sản Phẩm Mới" (ghi đè bằng env khi cần). */
const DEFAULT_BASE_TOKEN = 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
const DEFAULT_TABLE_ID = 'tbl1nivQ6Uv4E8mV';
const FLOW_FIELD = 'Quá trình thực hiện';

interface StoredAttachment {
  url: string;
  originalName: string | null;
  mimetype: string | null;
  size: number | null;
  isPrimary?: boolean;
  larkFileToken: string;
}

export interface NppImportResult {
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
  categories: Map<string, string>; // `${type}|${fold}` → tên chuẩn
  trademarks: Map<string, { id: number; name: string }>;
  unitMap: Map<string, string>;
  priceBooks: Map<string, { id: number; name: string }>;
  usersByOpenId: Map<string, { id: number; name: string }>;
  usersByName: Map<string, { id: number; name: string }[]>;
  customersByLark: Map<
    string,
    { id: number; code: string | null; name: string }
  >;
  customersByName: Map<
    string,
    { id: number; code: string | null; name: string }[]
  >;
  productsByLark: Map<string, { id: number; code: string }>;
  productsByName: Map<string, { id: number; code: string }[]>;
}

/** Nhập toàn bộ bảng "Bảng Giá Sản Phẩm Mới" từ Lark Base (idempotent theo record id). */
@Injectable()
export class NewProductPriceImportService {
  private readonly logger = new Logger(NewProductPriceImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly upload: UploadService,
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

  /** Bản ghi qua bitable v1 (giữ link/attachment/url) + trường Flow qua Base v3. */
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

    // v1 bỏ qua trường Flow → đọc riêng qua Base API v3.
    const flow = new Map<string, unknown>();
    let offset = 0;
    for (;;) {
      const size = Math.min(200, limit ? limit - offset : 200);
      if (size <= 0) break;
      const qs = new URLSearchParams({
        field_id: FLOW_FIELD,
        limit: String(size),
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
    const [
      categories,
      trademarks,
      unitMap,
      priceBooks,
      users,
      customers,
      products,
    ] = await Promise.all([
      this.prisma.category.findMany({ select: { name: true, type: true } }),
      this.prisma.tradeMark.findMany({ select: { id: true, name: true } }),
      loadUnitNameMap(this.prisma),
      this.prisma.priceBook.findMany({
        select: { id: true, name: true, isActive: true },
      }),
      this.prisma.user.findMany({
        select: { id: true, name: true, larkUserId: true },
      }),
      this.prisma.customer.findMany({
        where: { larkRecordId: { not: null } },
        select: { id: true, code: true, name: true, larkRecordId: true },
      }),
      this.prisma.product.findMany({
        select: {
          id: true,
          code: true,
          name: true,
          larkRecordId: true,
          isActive: true,
        },
      }),
    ]);
    const group = <T>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const k = key(r);
        if (!k) continue;
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return m;
    };
    return {
      categories: new Map(
        categories.map((c) => [`${c.type}|${foldText(c.name)}`, c.name]),
      ),
      trademarks: new Map(trademarks.map((t) => [foldText(t.name), t])),
      unitMap,
      priceBooks: new Map(
        [...priceBooks]
          .sort((a, b) => Number(a.isActive) - Number(b.isActive)) // bản đang dùng ghi đè sau
          .map((p) => [
            normalizePriceBookName(p.name),
            { id: p.id, name: p.name },
          ]),
      ),
      usersByOpenId: new Map(
        users
          .filter((u) => u.larkUserId)
          .map((u) => [u.larkUserId!, { id: u.id, name: u.name }]),
      ),
      usersByName: group(
        users.map((u) => ({ id: u.id, name: u.name })),
        (u) => foldText(u.name),
      ),
      customersByLark: new Map(
        customers.map((c) => [
          c.larkRecordId!,
          { id: c.id, code: c.code, name: c.name },
        ]),
      ),
      customersByName: group(
        customers.map((c) => ({ id: c.id, code: c.code, name: c.name })),
        (c) => foldText(c.name),
      ),
      productsByLark: new Map(
        products
          .filter((p) => p.larkRecordId)
          .map((p) => [p.larkRecordId!, { id: p.id, code: p.code }]),
      ),
      productsByName: group(
        products
          .filter((p) => p.isActive)
          .map((p) => ({ id: p.id, code: p.code, name: p.name })),
        (p) => foldText(p.name),
      ),
    };
  }

  /** Đổi 1 bản ghi Lark → dữ liệu phiếu (chưa gồm ảnh/tài liệu). */
  mapRecord(record: any, lk: Lookups, unmatched: Record<string, Set<string>>) {
    const f: Record<string, any> = record.fields ?? {};
    const notes: { field: string; value: string }[] = [];
    const miss = (bucket: string, field: string, value: string) => {
      if (!value) return;
      (unmatched[bucket] ??= new Set()).add(value);
      notes.push({ field, value });
    };

    const category = (field: string, type: string, larkName: string) => {
      const raw = larkText(fieldOf(f, larkName));
      if (!raw) return null;
      const found = lk.categories.get(`${type}|${foldText(raw)}`);
      if (!found) miss(`category_${type}`, field, raw);
      return found ?? raw; // giữ chữ gốc; apply-preview sẽ báo cần chuẩn hóa
    };

    const user = (value: unknown) => {
      const u = larkUser(value);
      if (!u) return { id: null as number | null, name: null as string | null };
      const byId = u.openId ? lk.usersByOpenId.get(u.openId) : undefined;
      if (byId) return { id: byId.id, name: byId.name };
      const byName = lk.usersByName.get(foldText(u.name));
      if (byName?.length === 1)
        return { id: byName[0].id, name: byName[0].name };
      miss('users', 'user', u.name);
      return { id: null, name: u.name || null };
    };

    const tmRaw = larkText(fieldOf(f, 'Thương hiệu'));
    const tm = tmRaw ? lk.trademarks.get(foldText(tmRaw)) : undefined;
    if (tmRaw && !tm) miss('trademarks', 'tradeMarkId', tmRaw);

    const unitRaw = larkText(fieldOf(f, 'Đơn vị tính'));
    let unit: string | null = null;
    if (unitRaw) {
      const res = resolveUnitFromMap(lk.unitMap, unitRaw);
      if (res.unknown) miss('units', 'unit', unitRaw);
      unit = res.name || unitRaw;
    }

    const pbRaw = larkText(fieldOf(f, 'Bảng Giá OEM'));
    const pb = pbRaw
      ? lk.priceBooks.get(normalizePriceBookName(pbRaw))
      : undefined;
    if (pbRaw && !pb) miss('priceBooks', 'oemPriceBookId', pbRaw);

    const oemCustomers = larkLinks(fieldOf(f, 'Tên Khách OEM'))
      .map((l) => {
        const byLark = l.recordId
          ? lk.customersByLark.get(l.recordId)
          : undefined;
        const byName =
          !byLark && l.text
            ? lk.customersByName.get(foldText(l.text))
            : undefined;
        const c = byLark ?? (byName?.length === 1 ? byName[0] : undefined);
        if (!c) {
          miss('customers', 'oemCustomers', l.text || l.recordId || '');
          return null;
        }
        return { customerId: c.id, code: c.code, name: c.name };
      })
      .filter(Boolean);

    const creator = user(fieldOf(f, 'Người Đề Xuất') ?? record.created_by);
    const costApprover = user(fieldOf(f, 'Người Duyệt Giá Cost'));

    const rawStage = fieldOf(f, FLOW_FIELD);
    let stage = larkStage(rawStage);
    if (!stage) {
      if (larkText(rawStage)) miss('stages', 'stage', larkText(rawStage));
      stage = NPP_STAGE.PROPOSAL;
    }

    const createdAt =
      larkDate(fieldOf(f, 'Ngày', 'Thời gian tạo')) ??
      larkDate(record.created_time) ??
      new Date();
    const modifiedAt =
      larkDate(fieldOf(f, 'Thời gian cập nhật')) ??
      larkDate(record.last_modified_time) ??
      createdAt;

    // Sản phẩm đã tạo (liên kết bảng Sản Phẩm) — chỉ dùng cho phiếu đã xong.
    let productId: number | null = null;
    let productCode: string | null = null;
    if (stage === NPP_STAGE.DONE) {
      const link = larkLinks(fieldOf(f, 'Liên kết'))[0];
      const byLark = link?.recordId
        ? lk.productsByLark.get(link.recordId)
        : undefined;
      const byName = lk.productsByName.get(
        foldText(fieldOf(f, 'Tên hàng hóa')),
      );
      const p = byLark ?? (byName?.length === 1 ? byName[0] : undefined);
      if (p) {
        productId = p.id;
        productCode = p.code;
      }
    }

    const money = (name: string) => larkNumber(fieldOf(f, name));
    const data = {
      productName: larkText(fieldOf(f, 'Tên hàng hóa')) || '(Chưa đặt tên)',
      stage,
      parentName: category('parentName', 'parent', 'Loại hàng'),
      childName: category('childName', 'child', 'Danh mục hàng'),
      middleName: category('middleName', 'middle', 'Nguồn gốc hàng'),
      tradeMarkId: tm?.id ?? null,
      tradeMarkName: tm?.name ?? (tmRaw || null),
      unit,
      netWeightGram: money('Khối lượng tịnh (gram)'),
      description: larkText(fieldOf(f, 'Mô Tả Sản Phẩm')) || null,
      uspUrl: larkUrl(fieldOf(f, 'USP & Truyền Thông')),
      usageUrl: larkUrl(fieldOf(f, 'Ứng Dụng Pha Chế/Sử Dụng')),
      rdUpdatedAt: larkDate(fieldOf(f, 'Thời Gian RD Cập Nhật Ứng Dụng')),
      costApproverId: costApprover.id,
      costApproverName: costApprover.name,
      supplierFactory: larkText(fieldOf(f, 'NCC - Nhà Máy')) || null,
      moqCartons: money('MOQ (Thùng)'),
      deliveryTerms: larkText(fieldOf(f, 'Điều Kiện Giao Hàng')) || null,
      importName: larkText(fieldOf(f, 'Tên Hàng Nhập Khẩu')) || null,
      arrivalDate: larkDate(fieldOf(f, 'Thời Gian Hàng Về')),
      launchDate: larkDate(fieldOf(f, 'Thời Gian Ra Mắt')),
      publicationInfo:
        larkLinks(fieldOf(f, 'Liên Kết Công Bố'))
          .map((l) => l.text)
          .filter(Boolean)
          .join(', ') || null,
      estimatedPublicationCost: money('Chi phí công bố dự tính'),
      packingSpec: money('Quy cách đóng gói'),
      goodsPrice: money('Giá hàng'),
      exchangeRate: money('Tỉ giá'),
      vatTax: money('Thuế GTGT'),
      importTax: money('Thuế Nhập Khẩu'),
      overheadCost: money('Chi phí chung'),
      costHn: money('Cost Hà Nội (trước VAT)'),
      costSg: money('Cost Sài Gòn (trước VAT)'),
      misaCode: larkText(fieldOf(f, 'Mã Misa')) || null,
      cogsHn: money('Giá vốn Hà Nội'),
      cogsSg: money('Giá vốn Sài Gòn'),
      cogsDt: money('Giá vốn CH Diệp Trà'),
      sendToChiefAccountant: larkBool(fieldOf(f, 'Gửi Kế Toán Trưởng')),
      chiefAccountantDecision: larkDecision(
        fieldOf(f, 'Kế toán trưởng kiểm tra'),
      ),
      priceHnRetail: money('HN - Giá Lẻ'),
      priceHnWholesale: money('HN- Giá Buôn'),
      priceSgRetail: money('SG - Giá Lẻ'),
      priceSgWholesale: money('SG - Giá Buôn'),
      priceDlcl: money('Giá ĐLCL'),
      priceShopee: money('Giá Shopee'),
      priceOem: money('Giá OEM'),
      oemPriceBookId: pb?.id ?? null,
      oemPriceBookName: pb?.name ?? (pbRaw || null),
      oemCustomers: oemCustomers.length
        ? (oemCustomers as Prisma.InputJsonValue)
        : Prisma.DbNull,
      ceoDecision: larkDecision(fieldOf(f, 'CEO duyệt bảng giá')),
      note: larkText(fieldOf(f, 'Ghi chú')) || null,
      productId,
      productCode,
      createdById: creator.id,
      createdByName: creator.name,
      createdAt,
      stageEnteredAt: modifiedAt,
      doneAt: stage === NPP_STAGE.DONE ? modifiedAt : null,
      endedAt: stage === NPP_STAGE.ENDED ? modifiedAt : null,
      importNotes: notes.length
        ? (notes as Prisma.InputJsonValue)
        : Prisma.DbNull,
    };
    const status = computeStatus(data as any);
    return { data: { ...data, status }, stage };
  }

  private async downloadAll(
    items: LarkAttachment[],
    existing: StoredAttachment[],
    token: string,
    subfolder: string,
    stats: NppImportResult['media'],
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
        const name = item.name || `${item.file_token}.jpg`;
        const mime = item.type || 'application/octet-stream';
        const saved = await this.upload.saveFile(buffer, name, mime, subfolder);
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
    dto: NppLarkImportDto,
    actor: { id: number; name?: string },
  ): Promise<NppImportResult> {
    const base =
      dto.baseToken ||
      this.config.get<string>('LARK_NEW_PRODUCT_PRICE_BASE_TOKEN') ||
      DEFAULT_BASE_TOKEN;
    const table =
      dto.tableId ||
      this.config.get<string>('LARK_NEW_PRODUCT_PRICE_TABLE_ID') ||
      DEFAULT_TABLE_ID;
    const dryRun = dto.dryRun !== false;
    const token = await this.token();
    const records = await this.fetchRecords(base, table, token, dto.limit);
    // Sinh mã SPM theo thứ tự thời gian tạo trên Lark.
    records.sort((a, b) => (a.created_time ?? 0) - (b.created_time ?? 0));

    const lk = await this.loadLookups();
    const unmatchedSets: Record<string, Set<string>> = {};
    const result: NppImportResult = {
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

    const existingRows = await this.prisma.newProductPriceTicket.findMany({
      where: { sourceRecordId: { in: records.map((r) => r.record_id) } },
      select: {
        id: true,
        sourceRecordId: true,
        updatedAt: true,
        lastImportedAt: true,
        images: true,
        documents: true,
      },
    });
    const existing = new Map(existingRows.map((r) => [r.sourceRecordId!, r]));

    const last = await this.prisma.newProductPriceTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let nextNum = last
      ? parseInt(last.code.slice(CODE_PREFIX.length), 10) || 0
      : 0;

    for (const record of records) {
      try {
        const { data, stage } = this.mapRecord(record, lk, unmatchedSets);
        result.byStage[stage] = (result.byStage[stage] ?? 0) + 1;
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

        const media: Record<string, any> = {};
        if (dto.downloadMedia) {
          const imgs = await this.downloadAll(
            larkAttachments(fieldOf(record.fields ?? {}, 'Hình ảnh sản phẩm')),
            (prev?.images as unknown as StoredAttachment[]) ?? [],
            token,
            'products',
            result.media,
          );
          if (imgs.length) imgs.forEach((img, i) => (img.isPrimary = i === 0));
          media.images = imgs.length ? imgs : Prisma.DbNull;
          const docs = await this.downloadAll(
            larkAttachments(fieldOf(record.fields ?? {}, 'Tài Liệu Đính Kèm')),
            (prev?.documents as unknown as StoredAttachment[]) ?? [],
            token,
            UPLOAD_SUBFOLDER,
            result.media,
          );
          media.documents = docs.length ? docs : Prisma.DbNull;
        }

        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          let ticketId: number;
          if (prev) {
            const { createdById, createdByName, createdAt, ...rest } = data;
            await tx.newProductPriceTicket.update({
              where: { id: prev.id },
              data: {
                ...(rest as any),
                ...media,
                createdById,
                createdByName,
                createdAt,
                lastImportedAt: now,
                updatedById: actor.id,
                updatedByName: actor.name ?? null,
              },
            });
            ticketId = prev.id;
            result.updated++;
          } else {
            nextNum += 1;
            const created = await tx.newProductPriceTicket.create({
              data: {
                ...(data as any),
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
          await tx.newProductPriceEvent.create({
            data: {
              ticketId,
              type: NPP_EVENT.IMPORTED,
              toStage: stage as NppStage,
              content: prev ? 'Cập nhật từ Lark Base' : 'Nhập từ Lark Base',
              data: { recordId: record.record_id },
              actorId: actor.id,
              actorName: actor.name ?? null,
            },
          });
          // updatedAt (tự động) lệch vài ms so với lastImportedAt — chấp nhận ở ngưỡng 1s.
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
      `Nhập Lark bảng giá SP mới: ${records.length} bản ghi, tạo ${result.created}, cập nhật ${result.updated}, dryRun=${dryRun}`,
    );
    return result;
  }
}
