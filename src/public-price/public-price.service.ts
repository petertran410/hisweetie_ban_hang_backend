import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  PRICE_GROUPS,
  PriceCatalogEntry,
  PricePageConfig,
  PriceRegionKey,
  PublicPriceData,
  PublicPriceProduct,
} from './public-price.types';
import {
  DEFAULT_REGIONS,
  knownBrandLabel,
  normalizeConfig,
  splitProductName,
  stripBrandPrefix,
} from './public-price.util';

export type PriceActor = { id: number; name: string };

const ROW_ID = 1;
const LE_HCM_BOOK = 'BẢNG GIÁ LẺ HCM';

type Published = { config: PricePageConfig; data: PublicPriceData };

@Injectable()
export class PublicPriceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Cấu hình đang sửa + trạng thái xuất bản (màn POS). */
  async getAdmin() {
    const row = await this.prisma.publicPricePage.findUnique({
      where: { id: ROW_ID },
    });
    const config = row
      ? normalizeConfig(row.draft)
      : await this.defaultConfig();
    const published = (row?.published ?? null) as Published | null;
    return {
      config,
      publishedAt: row?.publishedAt ?? null,
      publishedByName: row?.publishedByName ?? null,
      updatedAt: row?.updatedAt ?? null,
      hasPublished: !!published,
      dirty: published
        ? JSON.stringify(normalizeConfig(published.config)) !==
          JSON.stringify(config)
        : config.items.length > 0,
    };
  }

  async saveDraft(raw: unknown, actor: PriceActor) {
    const draft = normalizeConfig(raw) as unknown as Prisma.InputJsonValue;
    await this.prisma.publicPricePage.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, draft, updatedById: actor.id },
      update: { draft, updatedById: actor.id },
    });
    return this.getAdmin();
  }

  /** Dữ liệu xem trước theo cấu hình đang sửa (chưa lưu cũng được) + thông tin mọi sản phẩm trong cấu hình. */
  async preview(raw: unknown) {
    const config = normalizeConfig(raw);
    const { data, catalog } = await this.build(config, null);
    return { data, catalog };
  }

  async publish(actor: PriceActor) {
    const row = await this.prisma.publicPricePage.findUnique({
      where: { id: ROW_ID },
    });
    const config = row
      ? normalizeConfig(row.draft)
      : await this.defaultConfig();
    const now = new Date();
    const { data, inactiveRegions } = await this.build(config, now);
    if (inactiveRegions.length)
      throw new BadRequestException(
        `Bảng giá nguồn của ${inactiveRegions.map((r) => r.name).join(', ')} không tồn tại hoặc đã ngừng hoạt động — chọn bảng giá khác rồi xuất bản lại`,
      );
    const published = { config, data } as unknown as Prisma.InputJsonValue;
    await this.prisma.publicPricePage.upsert({
      where: { id: ROW_ID },
      create: {
        id: ROW_ID,
        draft: config as unknown as Prisma.InputJsonValue,
        published,
        publishedAt: now,
        publishedById: actor.id,
        publishedByName: actor.name,
        updatedById: actor.id,
      },
      update: {
        published,
        publishedAt: now,
        publishedById: actor.id,
        publishedByName: actor.name,
      },
    });
    await this.audit(
      actor,
      'PUBLIC_PRICE_PUBLISH',
      `Xuất bản bảng giá public: ${data.products.length} sản phẩm`,
    );
    return this.getAdmin();
  }

  /** Bỏ thay đổi chưa xuất bản: nháp quay về bản đang chạy. */
  async discard(actor: PriceActor) {
    const row = await this.prisma.publicPricePage.findUnique({
      where: { id: ROW_ID },
    });
    const published = (row?.published ?? null) as Published | null;
    if (!published)
      throw new NotFoundException('Chưa có bản xuất bản để hoàn tác');
    await this.prisma.publicPricePage.update({
      where: { id: ROW_ID },
      data: {
        draft: published.config as unknown as Prisma.InputJsonValue,
        updatedById: actor.id,
      },
    });
    return this.getAdmin();
  }

  /** Trang public: chỉ đọc bản đã xuất bản. */
  async publicData(): Promise<PublicPriceData> {
    const row = await this.prisma.publicPricePage.findUnique({
      where: { id: ROW_ID },
      select: { published: true },
    });
    const published = (row?.published ?? null) as Published | null;
    if (!published) throw new NotFoundException('Bảng giá chưa được xuất bản');
    return published.data;
  }

  private async defaultConfig(): Promise<PricePageConfig> {
    const leHcm = await this.prisma.priceBook.findFirst({
      where: { name: LE_HCM_BOOK, isActive: true },
      select: { id: true },
    });
    return normalizeConfig({
      regions: DEFAULT_REGIONS.map((r) =>
        r.key === 'S' ? { ...r, priceBookId: leHcm?.id ?? null } : r,
      ),
    });
  }

  /** Dựng dữ liệu trang public từ cấu hình: giá lấy theo bảng giá nguồn của từng khu vực. */
  async build(config: PricePageConfig, publishedAt: Date | null) {
    const ids = config.items.map((it) => it.productId);
    const products = ids.length
      ? await this.prisma.product.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            code: true,
            name: true,
            unit: true,
            basePrice: true,
            isActive: true,
            tradeMarkId: true,
            tradeMark: { select: { name: true } },
            images: {
              select: { image: true },
              orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
              take: 1,
            },
          },
        })
      : [];
    // Chỉ lấy giá từ bảng giá đang hoạt động: id lạ / bảng giá đã ngừng → giá "Liên hệ".
    const bookIds = config.regions
      .map((r) => r.priceBookId)
      .filter((id): id is number => id != null);
    const activeBookIds = bookIds.length
      ? (
          await this.prisma.priceBook.findMany({
            where: { id: { in: bookIds }, isActive: true },
            select: { id: true },
          })
        ).map((b) => b.id)
      : [];
    const inactiveRegions = config.regions.filter(
      (r) =>
        r.enabled &&
        r.priceBookId != null &&
        !activeBookIds.includes(r.priceBookId),
    );
    const details =
      ids.length && activeBookIds.length
        ? await this.prisma.priceBookDetail.findMany({
            where: {
              priceBookId: { in: activeBookIds },
              productId: { in: ids },
              isActive: true,
            },
            select: { priceBookId: true, productId: true, price: true },
          })
        : [];
    const bookPrice = new Map(
      details.map((d) => [`${d.priceBookId}:${d.productId}`, Number(d.price)]),
    );
    const byId = new Map(products.map((p) => [p.id, p]));

    const priceOf = (p: (typeof products)[number], key: PriceRegionKey) => {
      const region = config.regions.find((r) => r.key === key)!;
      const v =
        region.priceBookId == null
          ? Number(p.basePrice)
          : bookPrice.get(`${region.priceBookId}:${p.id}`);
      return v != null && v > 0 ? v : null;
    };

    const catalog: PriceCatalogEntry[] = products.map((p) => ({
      id: p.id,
      code: p.code,
      fullName: p.name,
      image: p.images[0]?.image ?? null,
      isActive: p.isActive,
      tradeMarkId: p.tradeMarkId,
      tradeMarkName: p.tradeMark?.name ?? null,
      price: { N: priceOf(p, 'N'), S: priceOf(p, 'S') },
    }));

    const brandCfg = new Map(config.brands.map((b) => [b.tradeMarkId, b]));
    const shown: PublicPriceProduct[] = [];
    for (const g of PRICE_GROUPS) {
      if (config.hiddenGroups.includes(g.key)) continue;
      for (const it of config.items) {
        const p = byId.get(it.productId);
        if (it.group !== g.key || !it.visible || !p || !p.isActive) continue;
        if (
          p.tradeMarkId != null &&
          brandCfg.get(p.tradeMarkId)?.visible === false
        )
          continue;
        const parts = splitProductName(p.name);
        const name = it.name || stripBrandPrefix(parts.name, p.tradeMark?.name);
        shown.push({
          id: p.id,
          code: p.code,
          name,
          size: parts.size,
          spec: parts.spec,
          unit: p.unit || parts.unit,
          brandId: p.tradeMarkId,
          group: g.key,
          image: p.images[0]?.image ?? null,
          tag: it.tag,
          desc: it.desc,
          price: {
            N: it.hidePrice.includes('N') ? null : priceOf(p, 'N'),
            S: it.hidePrice.includes('S') ? null : priceOf(p, 'S'),
          },
        });
      }
    }

    // Badge thương hiệu: theo thứ tự cấu hình, rồi tới thương hiệu chưa cấu hình (theo thứ tự xuất hiện).
    const usedBrands = new Map<number, string>();
    for (const s of shown) {
      if (s.brandId == null || usedBrands.has(s.brandId)) continue;
      usedBrands.set(s.brandId, byId.get(s.id)?.tradeMark?.name ?? '');
    }
    const brands = [
      ...config.brands
        .filter((b) => usedBrands.has(b.tradeMarkId))
        .map((b) => b.tradeMarkId),
      ...[...usedBrands.keys()].filter((id) => !brandCfg.has(id)),
    ].map((id) => ({
      id,
      name:
        brandCfg.get(id)?.label || knownBrandLabel(usedBrands.get(id) ?? ''),
    }));

    const data: PublicPriceData = {
      publishedAt: publishedAt ? publishedAt.toISOString() : null,
      validFrom: config.validFrom,
      validTo: config.validTo,
      zaloUrl: config.zaloUrl,
      banner: config.banner,
      regions: config.regions
        .filter((r) => r.enabled)
        .map(({ key, name, listName, hotline }) => ({
          key,
          name,
          listName,
          hotline,
        })),
      groups: PRICE_GROUPS.filter((g) => !config.hiddenGroups.includes(g.key)),
      brands,
      products: shown,
    };
    return { data, catalog, inactiveRegions };
  }

  private audit(actor: PriceActor, actionCode: string, message: string) {
    return this.auditLogs.create({
      actionType: 'POST',
      actionCode,
      entityType: 'public_price_pages',
      entityId: String(ROW_ID),
      message,
      userId: actor.id,
      userName: actor.name,
    });
  }
}
