import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import type {
  CreateFactoryProductDto,
  FactoryProductQueryDto,
  ReferencePricesQueryDto,
  UpdateFactoryProductDto,
} from './dto';

/**
 * Quản lý mapping (nhà máy × sản phẩm) — tương ứng sheet "Product Mapping"
 * trong file Excel quản lý nhà máy.
 *
 * Điểm cốt lõi:
 * - Mỗi sản phẩm được gắn nhiều nhà máy, phân theo `role` (primary/backup) và
 *   `priority`. Không giới hạn số lượng.
 * - `referencePrice` là GIÁ THAM CHIẾU do người dùng nhập, dùng làm mốc so
 *   sánh với đơn giá thực tế mỗi lần đặt hàng nhập.
 * - Mỗi lần `referencePrice` thay đổi → ghi 1 dòng FactoryProductPriceHistory
 *   trong cùng transaction để không mất lịch sử.
 * - `exchangeRate`: nếu người dùng không nhập tay thì lấy tự động từ
 *   ExchangeRatesService (cache 15p). Khi nhập tay thì `isManualRate = true`
 *   và KHÔNG bị API ghi đè.
 */
@Injectable()
export class FactoryProductsService {
  constructor(
    private prisma: PrismaService,
    private exchangeRates: ExchangeRatesService,
  ) {}

  private readonly productSelect = {
    id: true,
    code: true,
    name: true,
    isActive: true,
    images: {
      take: 1,
      orderBy: { id: 'asc' as const },
      select: { image: true },
    },
  };

  private readonly factorySelect = {
    id: true,
    code: true,
    name: true,
    country: true,
    currency: true,
    supplierId: true,
  };

  /**
   * Quy đổi giá tham chiếu về VND để so sánh giữa các nhà máy khác tiền tệ.
   * Trả null khi thiếu giá.
   */
  private toVnd(
    price: Prisma.Decimal | null,
    rate: Prisma.Decimal | null,
    currency: string,
  ): number | null {
    if (price == null) return null;
    const value = Number(price);
    if (currency === 'VND') return value;
    if (rate == null) return null;
    return value * Number(rate);
  }

  /**
   * Lấy tỉ giá dùng cho 1 dòng mapping.
   * - currency = VND → 1
   * - người dùng nhập tay → dùng đúng số đó
   * - còn lại → gọi API (thất bại thì trả null, không chặn lưu)
   */
  private async resolveRate(
    currency: string,
    manualRate: number | undefined,
    isManual: boolean | undefined,
  ): Promise<{ exchangeRate: number | null; isManualRate: boolean }> {
    if (currency === 'VND') return { exchangeRate: 1, isManualRate: false };

    if (isManual && manualRate != null && manualRate > 0) {
      return { exchangeRate: manualRate, isManualRate: true };
    }
    if (manualRate != null && manualRate > 0) {
      return { exchangeRate: manualRate, isManualRate: true };
    }

    try {
      const info = await this.exchangeRates.getLatestRate(currency, 'VND');
      return { exchangeRate: info?.rate ?? null, isManualRate: false };
    } catch {
      // Không có mạng / API lỗi → vẫn cho lưu, chỉ thiếu tỉ giá.
      return { exchangeRate: null, isManualRate: false };
    }
  }

  async findAll(query: FactoryProductQueryDto = {} as FactoryProductQueryDto) {
    const where: Prisma.FactoryProductWhereInput = {};
    if (!query.includeInactive) where.isActive = true;
    if (query.factoryId) where.factoryId = query.factoryId;
    if (query.productId) where.productId = query.productId;
    if (query.role) where.role = query.role;

    const rows = await this.prisma.factoryProduct.findMany({
      where,
      orderBy: [{ role: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
      include: {
        product: { select: this.productSelect },
        factory: { select: this.factorySelect },
        priceUpdatedBy: { select: { id: true, name: true } },
      },
    });

    return rows.map((row) => ({
      ...row,
      referencePriceVnd: this.toVnd(
        row.referencePrice,
        row.exchangeRate,
        row.currency,
      ),
    }));
  }

  async findOne(id: number) {
    const row = await this.prisma.factoryProduct.findUnique({
      where: { id },
      include: {
        product: { select: this.productSelect },
        factory: { select: this.factorySelect },
        priceUpdatedBy: { select: { id: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException('Không tìm thấy mapping nhà máy');
    return {
      ...row,
      referencePriceVnd: this.toVnd(
        row.referencePrice,
        row.exchangeRate,
        row.currency,
      ),
    };
  }

  async create(dto: CreateFactoryProductDto, userId: number) {
    const [factory, product] = await Promise.all([
      this.prisma.factory.findUnique({
        where: { id: dto.factoryId },
        select: { id: true, currency: true },
      }),
      this.prisma.product.findUnique({
        where: { id: dto.productId },
        select: { id: true },
      }),
    ]);
    if (!factory) {
      throw new BadRequestException(
        `Nhà máy ID ${dto.factoryId} không tồn tại`,
      );
    }
    if (!product) {
      throw new BadRequestException(
        `Sản phẩm ID ${dto.productId} không tồn tại`,
      );
    }

    const dup = await this.prisma.factoryProduct.findUnique({
      where: {
        factoryId_productId: {
          factoryId: dto.factoryId,
          productId: dto.productId,
        },
      },
      select: { id: true },
    });
    if (dup) {
      throw new BadRequestException(
        'Sản phẩm này đã được gắn vào nhà máy. Hãy sửa dòng hiện có.',
      );
    }

    const currency = dto.currency?.trim() || factory.currency || 'VND';
    const { exchangeRate, isManualRate } = await this.resolveRate(
      currency,
      dto.exchangeRate,
      dto.isManualRate,
    );

    const hasPrice = dto.referencePrice != null;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.factoryProduct.create({
        data: {
          factoryId: dto.factoryId,
          productId: dto.productId,
          role: dto.role ?? 'primary',
          priority: dto.priority ?? 0,
          referencePrice: dto.referencePrice ?? null,
          currency,
          exchangeRate,
          isManualRate,
          moq: dto.moq ?? null,
          leadtimeDays: dto.leadtimeDays ?? null,
          note: dto.note ?? null,
          isActive: dto.isActive ?? true,
          priceUpdatedAt: hasPrice ? new Date() : null,
          priceUpdatedById: hasPrice ? userId : null,
          createdBy: userId,
        },
      });

      // Ghi mốc giá đầu tiên để lịch sử đầy đủ ngay từ lần tạo.
      if (hasPrice) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        await tx.factoryProductPriceHistory.create({
          data: {
            factoryProductId: created.id,
            oldPrice: null,
            newPrice: dto.referencePrice ?? null,
            currency,
            exchangeRate,
            reason: dto.reason?.trim() || 'Thiết lập giá ban đầu',
            changedById: userId,
            changedByName: user?.name ?? null,
          },
        });
      }

      return created;
    });
  }

  async update(id: number, dto: UpdateFactoryProductDto, userId: number) {
    const existing = await this.prisma.factoryProduct.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy mapping nhà máy');
    }

    const data: Prisma.FactoryProductUpdateInput = {};

    if (dto.role !== undefined) data.role = dto.role;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.moq !== undefined) data.moq = dto.moq ?? null;
    if (dto.leadtimeDays !== undefined) {
      data.leadtimeDays = dto.leadtimeDays ?? null;
    }
    if (dto.note !== undefined) data.note = dto.note ?? null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    // Tiền tệ mới (nếu đổi) quyết định việc phải tính lại tỉ giá.
    const currency = dto.currency?.trim() || existing.currency;
    const currencyChanged = currency !== existing.currency;

    const priceChanged =
      dto.referencePrice !== undefined &&
      Number(dto.referencePrice ?? 0) !== Number(existing.referencePrice ?? 0);

    const rateProvided = dto.exchangeRate !== undefined;

    if (currencyChanged) data.currency = currency;

    // Chỉ gọi API tỉ giá khi thật sự cần: đổi tiền tệ, đổi giá, hoặc user
    // gửi tỉ giá mới. Tránh gọi ngoài mạng cho các sửa đổi không liên quan.
    if (currencyChanged || priceChanged || rateProvided) {
      const { exchangeRate, isManualRate } = await this.resolveRate(
        currency,
        dto.exchangeRate,
        dto.isManualRate ?? existing.isManualRate,
      );
      // Giữ tỉ giá tay cũ nếu user không gửi gì mới và tiền tệ không đổi.
      if (rateProvided || currencyChanged || !existing.isManualRate) {
        data.exchangeRate = exchangeRate;
        data.isManualRate = isManualRate;
      }
    }

    if (dto.referencePrice !== undefined) {
      data.referencePrice = dto.referencePrice ?? null;
      if (priceChanged) {
        data.priceUpdatedAt = new Date();
        data.priceUpdatedBy = { connect: { id: userId } };
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.factoryProduct.update({ where: { id }, data });

      if (priceChanged) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        await tx.factoryProductPriceHistory.create({
          data: {
            factoryProductId: id,
            oldPrice: existing.referencePrice,
            newPrice: updated.referencePrice,
            currency: updated.currency,
            exchangeRate: updated.exchangeRate,
            reason: dto.reason?.trim() || null,
            changedById: userId,
            changedByName: user?.name ?? null,
          },
        });
      }

      return updated;
    });
  }

  async remove(id: number) {
    const existing = await this.prisma.factoryProduct.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy mapping nhà máy');
    }
    // Xóa cứng: history có onDelete Cascade nên tự dọn theo.
    return this.prisma.factoryProduct.delete({ where: { id } });
  }

  /**
   * Lịch sử thay đổi giá tham chiếu của 1 dòng mapping, mới nhất trước.
   */
  async getPriceHistory(factoryProductId: number) {
    await this.findOne(factoryProductId);
    return this.prisma.factoryProductPriceHistory.findMany({
      where: { factoryProductId },
      orderBy: { createdAt: 'desc' },
      include: { changer: { select: { id: true, name: true } } },
    });
  }

  /**
   * Giá tham chiếu theo productId — dùng cho form đặt hàng nhập để hiển thị
   * chênh lệch giữa đơn giá thực tế và giá tham chiếu.
   *
   * Ưu tiên chọn dòng: role primary trước backup, rồi priority nhỏ hơn.
   * Lọc theo `factoryId` nếu truyền, ngược lại theo tất cả nhà máy của
   * `supplierId`.
   */
  async getReferencePrices(query: ReferencePricesQueryDto) {
    const result: Record<
      number,
      {
        factoryProductId: number;
        factoryId: number;
        factoryName: string;
        referencePrice: number | null;
        currency: string;
        exchangeRate: number | null;
        referencePriceVnd: number | null;
        moq: number | null;
        priceUpdatedAt: Date | null;
      } | null
    > = {};

    const productIds = (query.productIds ?? []).filter(
      (id) => Number.isFinite(id) && id > 0,
    );
    if (!productIds.length) return result;
    productIds.forEach((id) => (result[id] = null));

    const where: Prisma.FactoryProductWhereInput = {
      productId: { in: productIds },
      isActive: true,
    };
    if (query.factoryId) {
      where.factoryId = query.factoryId;
    } else if (query.supplierId) {
      where.factory = { supplierId: query.supplierId };
    }

    const rows = await this.prisma.factoryProduct.findMany({
      where,
      orderBy: [{ role: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
      include: { factory: { select: { id: true, name: true } } },
    });

    // role 'backup' < 'primary' theo alphabet nên sort ở DB không đủ —
    // ưu tiên primary thủ công tại đây.
    const rank = (role: string) => (role === 'primary' ? 0 : 1);
    const sorted = [...rows].sort(
      (a, b) => rank(a.role) - rank(b.role) || a.priority - b.priority,
    );

    for (const row of sorted) {
      if (result[row.productId]) continue;
      result[row.productId] = {
        factoryProductId: row.id,
        factoryId: row.factoryId,
        factoryName: row.factory.name,
        referencePrice:
          row.referencePrice != null ? Number(row.referencePrice) : null,
        currency: row.currency,
        exchangeRate:
          row.exchangeRate != null ? Number(row.exchangeRate) : null,
        referencePriceVnd: this.toVnd(
          row.referencePrice,
          row.exchangeRate,
          row.currency,
        ),
        moq: row.moq != null ? Number(row.moq) : null,
        priceUpdatedAt: row.priceUpdatedAt,
      };
    }

    return result;
  }
}
