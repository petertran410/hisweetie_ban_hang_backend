import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toVnd } from '../common/currency.util';
import { normalizeMoqSpec } from '../common/moq.util';
import {
  CreateFactoryProductDto,
  FactoryProductQueryDto,
  PriceHistorySeriesQueryDto,
  ReferencePricesQueryDto,
  UpdateFactoryProductDto,
} from './dto';

const PURCHASE_ORDER_REASON_PREFIX = 'Giá đặt hàng nhập ';

@Injectable()
export class FactoryProductsService {
  constructor(private prisma: PrismaService) {}

  private toVnd(
    price: any,
    currency: string | null | undefined,
    exchangeRate: any,
  ) {
    return toVnd(price, currency, exchangeRate);
  }

  private serialize(mapping: any) {
    const referencePrice =
      mapping.referencePrice == null ? null : Number(mapping.referencePrice);
    const exchangeRate =
      mapping.exchangeRate == null ? null : Number(mapping.exchangeRate);

    return {
      ...mapping,
      referencePrice,
      exchangeRate,
      moq: mapping.moq == null ? null : Number(mapping.moq),
      referencePriceVnd:
        referencePrice == null
          ? null
          : mapping.currency === 'VND'
            ? referencePrice
            : exchangeRate == null
              ? null
              : referencePrice * exchangeRate,
    };
  }

  private mappingInclude = {
    products: {
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        images: {
          take: 1,
          orderBy: { id: 'asc' as const },
          select: { image: true },
        },
      },
    },
    factories: {
      select: {
        id: true,
        code: true,
        name: true,
        country: true,
        currency: true,
        supplierId: true,
      },
    },
    users_factory_products_priceUpdatedByIdTousers: {
      select: { id: true, name: true },
    },
  };

  async findAll(query: FactoryProductQueryDto) {
    const where: any = {};
    if (query.factoryId != null) where.factoryId = query.factoryId;
    if (query.productId != null) where.productId = query.productId;
    if (query.role) where.role = query.role;
    if (!query.includeInactive) where.isActive = true;

    const mappings = await this.prisma.factory_products.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      include: this.mappingInclude,
    });

    return mappings.map((mapping) =>
      this.serialize({
        ...mapping,
        product: mapping.products,
        factory: mapping.factories,
        priceUpdatedBy: mapping.users_factory_products_priceUpdatedByIdTousers,
      }),
    );
  }

  async findOne(id: number) {
    const mapping = await this.prisma.factory_products.findUnique({
      where: { id },
      include: this.mappingInclude,
    });
    if (!mapping)
      throw new NotFoundException('Không tìm thấy sản phẩm của nhà máy');

    return this.serialize({
      ...mapping,
      product: mapping.products,
      factory: mapping.factories,
      priceUpdatedBy: mapping.users_factory_products_priceUpdatedByIdTousers,
    });
  }

  async create(
    dto: CreateFactoryProductDto,
    userId: number,
    userName?: string | null,
  ) {
    const [factory, product, existing] = await Promise.all([
      this.prisma.factory.findUnique({
        where: { id: dto.factoryId },
        select: { id: true },
      }),
      this.prisma.product.findUnique({
        where: { id: dto.productId },
        select: { id: true },
      }),
      this.prisma.factory_products.findUnique({
        where: {
          factoryId_productId: {
            factoryId: dto.factoryId,
            productId: dto.productId,
          },
        },
      }),
    ]);
    if (!factory) throw new BadRequestException('Nhà máy không tồn tại');
    if (!product) throw new BadRequestException('Sản phẩm không tồn tại');
    if (existing)
      throw new BadRequestException('Sản phẩm đã được gắn với nhà máy này');

    const currency = (dto.currency || 'VND').toUpperCase();
    const referencePrice = dto.referencePrice ?? null;
    const mapping = await this.prisma.$transaction(async (tx) => {
      const created = await tx.factory_products.create({
        data: {
          factoryId: dto.factoryId,
          productId: dto.productId,
          role: dto.role || 'primary',
          priority: dto.priority ?? 0,
          referencePrice,
          currency,
          exchangeRate: dto.exchangeRate ?? (currency === 'VND' ? 1 : null),
          isManualRate: dto.isManualRate ?? false,
          moq: dto.moq ?? null,
          moqValue: dto.moqValue ?? null,
          moqBasis: dto.moqBasis ?? null,
          moqUnit: dto.moqUnit ?? null,
          moqIncrement: dto.moqIncrement ?? null,
          leadtimeDays: dto.leadtimeDays ?? null,
          note: dto.note ?? null,
          isActive: dto.isActive ?? true,
          priceUpdatedAt: referencePrice == null ? null : new Date(),
          priceUpdatedById: referencePrice == null ? null : userId,
          createdBy: userId,
          updatedAt: new Date(),
        },
      });
      if (referencePrice != null) {
        await tx.factory_product_price_histories.create({
          data: {
            factoryProductId: created.id,
            oldPrice: null,
            newPrice: referencePrice,
            oldPriceVnd: null,
            newPriceVnd: this.toVnd(
              referencePrice,
              currency,
              dto.exchangeRate ?? (currency === 'VND' ? 1 : null),
            ),
            currency,
            exchangeRate: dto.exchangeRate ?? (currency === 'VND' ? 1 : null),
            eventType: 'reference',
            refCode: null,
            reason: dto.reason || 'Thiết lập giá tham chiếu',
            changedById: userId,
            changedByName: userName || null,
          },
        });
      }
      return created;
    });

    return this.findOne(mapping.id);
  }

  async update(
    id: number,
    dto: UpdateFactoryProductDto,
    userId: number,
    userName?: string | null,
  ) {
    const existing = await this.prisma.factory_products.findUnique({
      where: { id },
    });
    if (!existing)
      throw new NotFoundException('Không tìm thấy sản phẩm của nhà máy');

    const nextReferencePrice =
      dto.referencePrice === undefined
        ? existing.referencePrice
        : dto.referencePrice;
    const priceChanged =
      dto.referencePrice !== undefined &&
      Number(existing.referencePrice ?? -1) !==
        Number(dto.referencePrice ?? -1);
    const currency = (dto.currency || existing.currency || 'VND').toUpperCase();
    const exchangeRate =
      dto.exchangeRate === undefined ? existing.exchangeRate : dto.exchangeRate;

    await this.prisma.$transaction(async (tx) => {
      await tx.factory_products.update({
        where: { id },
        data: {
          role: dto.role,
          priority: dto.priority,
          referencePrice: nextReferencePrice,
          currency,
          exchangeRate,
          isManualRate: dto.isManualRate,
          moq: dto.moq,
          moqValue: dto.moqValue,
          moqBasis: dto.moqBasis,
          moqUnit: dto.moqUnit,
          moqIncrement: dto.moqIncrement,
          leadtimeDays: dto.leadtimeDays,
          note: dto.note,
          isActive: dto.isActive,
          priceUpdatedAt: priceChanged ? new Date() : undefined,
          priceUpdatedById: priceChanged ? userId : undefined,
        },
      });
      if (priceChanged) {
        await tx.factory_product_price_histories.create({
          data: {
            factoryProductId: id,
            oldPrice: existing.referencePrice,
            newPrice: nextReferencePrice,
            oldPriceVnd: this.toVnd(
              existing.referencePrice,
              existing.currency,
              existing.exchangeRate,
            ),
            newPriceVnd: this.toVnd(nextReferencePrice, currency, exchangeRate),
            currency,
            exchangeRate,
            eventType: 'reference',
            refCode: null,
            reason: dto.reason || 'Cập nhật giá tham chiếu',
            changedById: userId,
            changedByName: userName || null,
          },
        });
      }
    });

    return this.findOne(id);
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.factory_products.delete({ where: { id } });
  }

  async getPriceHistory(id: number) {
    await this.findOne(id);
    const histories =
      await this.prisma.factory_product_price_histories.findMany({
        where: { factoryProductId: id },
        orderBy: { createdAt: 'desc' },
        include: { users: { select: { id: true, name: true } } },
      });
    return histories.map((history) => ({
      ...history,
      oldPrice: history.oldPrice == null ? null : Number(history.oldPrice),
      newPrice: history.newPrice == null ? null : Number(history.newPrice),
      oldPriceVnd:
        history.oldPriceVnd == null ? null : Number(history.oldPriceVnd),
      newPriceVnd:
        history.newPriceVnd == null ? null : Number(history.newPriceVnd),
      exchangeRate:
        history.exchangeRate == null ? null : Number(history.exchangeRate),
      changer: history.users,
    }));
  }

  async getPriceHistorySeries(query: PriceHistorySeriesQueryDto) {
    const factoryIds = query.factoryIds
      ? [
          ...new Set(
            query.factoryIds
              .split(',')
              .map((id) => Number(id.trim()))
              .filter((id) => Number.isInteger(id) && id > 0),
          ),
        ]
      : [];
    if (query.factoryIds && !factoryIds.length) {
      throw new BadRequestException('factoryIds không hợp lệ');
    }

    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw new BadRequestException('Khoảng thời gian không hợp lệ');
    }

    const where: any = {};
    if (query.eventType) where.eventType = query.eventType;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }
    if (query.productId != null || factoryIds.length) {
      where.factory_products = {
        productId: query.productId,
        ...(factoryIds.length ? { factoryId: { in: factoryIds } } : {}),
      };
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 100, 500);
    const [histories, total] = await this.prisma.$transaction([
      this.prisma.factory_product_price_histories.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          users: { select: { id: true, name: true } },
          factory_products: {
            select: {
              id: true,
              factoryId: true,
              productId: true,
              factories: { select: { id: true, code: true, name: true } },
              products: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.factory_product_price_histories.count({ where }),
    ]);

    const currencyMode = query.currencyMode ?? 'vnd';
    const points = histories.map((history) => {
      const mapping = history.factory_products;
      const nativePrice =
        history.newPrice == null ? null : Number(history.newPrice);
      const vndPrice =
        history.newPriceVnd == null
          ? this.toVnd(history.newPrice, history.currency, history.exchangeRate)
          : Number(history.newPriceVnd);
      return {
        id: history.id,
        factoryProductId: history.factoryProductId,
        factory: mapping.factories,
        product: mapping.products,
        eventType: history.eventType,
        refCode: history.refCode,
        reason: history.reason,
        nativePrice,
        vndPrice,
        value: currencyMode === 'vnd' ? vndPrice : nativePrice,
        currency: history.currency,
        exchangeRate:
          history.exchangeRate == null ? null : Number(history.exchangeRate),
        changedByName: history.changedByName || history.users?.name || null,
        createdAt: history.createdAt,
      };
    });
    const values = points
      .map((point) => point.value)
      .filter(
        (value): value is number => value != null && Number.isFinite(value),
      );
    const first = values[0] ?? null;
    const latest = values.length ? values[values.length - 1] : null;

    return {
      points,
      summary: {
        first,
        latest,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        change: first == null || latest == null ? null : latest - first,
        changePercent:
          first == null || latest == null || first === 0
            ? null
            : ((latest - first) / first) * 100,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      currencyMode,
    };
  }

  async getReferencePrices(query: ReferencePricesQueryDto) {
    const productIds = [
      ...new Set(
        query.productIds
          .split(',')
          .map((id) => Number(id.trim()))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (!productIds.length)
      throw new BadRequestException('productIds không hợp lệ');

    const where: any = { productId: { in: productIds }, isActive: true };
    if (query.factoryId != null) where.factoryId = query.factoryId;
    if (query.supplierId != null)
      where.factories = { supplierId: query.supplierId };

    const mappings = await this.prisma.factory_products.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      include: {
        factories: {
          select: {
            id: true,
            name: true,
            // MOQ cấp nhà máy — FE cần để cảnh báo ràng buộc toàn đơn.
            moq: true,
            moqValue: true,
            moqBasis: true,
            moqUnit: true,
            moqScope: true,
            moqIncrement: true,
          },
        },
        // Dữ liệu quy đổi MOQ khối lượng / thùng.
        products: {
          select: {
            id: true,
            name: true,
            conversionValue: true,
            weight: true,
            weightUnit: true,
          },
        },
      },
    });
    const byProduct = new Map<number, any>();
    for (const mapping of mappings) {
      if (!byProduct.has(mapping.productId))
        byProduct.set(mapping.productId, mapping);
    }

    return Object.fromEntries(
      productIds.map((productId) => {
        const mapping = byProduct.get(productId);
        if (!mapping) return [productId, null];
        const referencePrice =
          mapping.referencePrice == null
            ? null
            : Number(mapping.referencePrice);
        const exchangeRate =
          mapping.exchangeRate == null ? null : Number(mapping.exchangeRate);
        return [
          productId,
          {
            factoryProductId: mapping.id,
            factoryId: mapping.factoryId,
            factoryName: mapping.factories.name,
            referencePrice,
            currency: mapping.currency,
            exchangeRate,
            referencePriceVnd:
              referencePrice == null
                ? null
                : mapping.currency === 'VND'
                  ? referencePrice
                  : exchangeRate == null
                    ? null
                    : referencePrice * exchangeRate,
            moq: mapping.moq == null ? null : Number(mapping.moq),
            /** Cụm MOQ đã chuẩn hoá — FE dùng thẳng để cảnh báo trên PĐN. */
            moqSpec: normalizeMoqSpec(mapping, 'PER_LINE'),
            /** MOQ cấp nhà máy (ràng buộc độc lập với MOQ cấp dòng). */
            factoryMoqSpec: normalizeMoqSpec(mapping.factories, 'PER_ORDER'),
            /** Dữ liệu để FE quy đổi gói lẻ → thùng / kg / tấn. */
            conversionValue:
              mapping.products?.conversionValue == null
                ? null
                : Number(mapping.products.conversionValue),
            weight:
              mapping.products?.weight == null
                ? null
                : Number(mapping.products.weight),
            weightUnit: mapping.products?.weightUnit ?? null,
            priceUpdatedAt: mapping.priceUpdatedAt,
          },
        ];
      }),
    );
  }

  async recordConfirmedOrderSupplierPrices(
    tx: any,
    orderSupplier: {
      id: number;
      code: string;
      currency: string | null;
      exchangeRate: any;
      items: Array<{
        factoryId: number | null;
        productId: number;
        factoryPrice: any;
      }>;
    },
    userId: number,
    userName?: string | null,
  ) {
    const currency = (orderSupplier.currency || 'VND').toUpperCase();
    const exchangeRate =
      orderSupplier.exchangeRate ?? (currency === 'VND' ? 1 : null);

    for (const item of orderSupplier.items) {
      if (item.factoryId == null || item.factoryPrice == null) continue;
      let mapping = await tx.factory_products.findUnique({
        where: {
          factoryId_productId: {
            factoryId: item.factoryId,
            productId: item.productId,
          },
        },
      });
      if (!mapping) {
        mapping = await tx.factory_products.create({
          data: {
            factoryId: item.factoryId,
            productId: item.productId,
            currency,
            exchangeRate,
            isManualRate: false,
            createdBy: userId,
            updatedAt: new Date(),
          },
        });
      }
      const reason = `${PURCHASE_ORDER_REASON_PREFIX}${orderSupplier.code}`;
      const alreadyRecorded =
        await tx.factory_product_price_histories.findFirst({
          where: {
            factoryProductId: mapping.id,
            OR: [
              { eventType: 'purchase_order', refCode: orderSupplier.code },
              { reason },
            ],
          },
          select: { id: true },
        });
      if (alreadyRecorded) continue;

      const previous = await tx.factory_product_price_histories.findFirst({
        where: {
          factoryProductId: mapping.id,
          eventType: 'purchase_order',
        },
        orderBy: { createdAt: 'desc' },
        select: {
          newPrice: true,
          newPriceVnd: true,
        },
      });
      await tx.factory_product_price_histories.create({
        data: {
          factoryProductId: mapping.id,
          oldPrice: previous?.newPrice ?? mapping.referencePrice,
          newPrice: item.factoryPrice,
          oldPriceVnd:
            previous?.newPriceVnd ??
            this.toVnd(
              mapping.referencePrice,
              mapping.currency,
              mapping.exchangeRate,
            ),
          newPriceVnd: this.toVnd(item.factoryPrice, currency, exchangeRate),
          currency,
          exchangeRate,
          eventType: 'purchase_order',
          refCode: orderSupplier.code,
          reason,
          changedById: userId,
          changedByName: userName || null,
        },
      });
    }
  }
}
