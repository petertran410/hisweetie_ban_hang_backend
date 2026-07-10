import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  EvaluatePromotionDto,
  PromotionQueryDto,
} from './dto';
import {
  EnginePromotion,
  EngineContext,
  EngineItem,
  evaluatePromotions,
} from './promotion-engine';
import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';
import { ORDER_STATUS } from '../orders/dto/order-status.constants';

const PROMOTION_TYPE_LABELS: Record<string, string> = {
  INVOICE_DISCOUNT: 'Giảm giá hóa đơn',
  PRODUCT_DISCOUNT: 'Giảm giá hàng hóa',
  BUY_X_GET_Y: 'Mua X tặng Y',
  BUY_N_GET_M_SAME: 'Mua N tặng M cùng loại',
  BUY_X_BUY_Y_PRICE: 'Mua X mua kèm Y giá KM',
  GIFT_BY_INVOICE: 'Quà tặng theo hóa đơn',
  CATEGORY_DISCOUNT: 'Giảm giá theo nhóm hàng',
};

const PROMOTION_STATUS_LABELS: Record<string, string> = {
  draft: 'Nháp',
  running: 'Đang chạy',
  paused: 'Tạm dừng',
  stopped: 'Đã ngừng',
  expired: 'Hết hạn',
};

const REWARD_TYPE_LABELS: Record<string, string> = {
  discount_percent: 'Giảm %',
  discount_amount: 'Giảm tiền',
  gift: 'Quà tặng',
  discounted_buy: 'Mua kèm giá KM',
};

@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  // ----------------------------- CRUD -----------------------------

  async create(dto: CreatePromotionDto, userId: number) {
    this.validatePayload(dto);
    this.validateScope(dto);

    const exists = await this.prisma.promotion.findUnique({
      where: { code: dto.code },
    });
    if (exists)
      throw new BadRequestException(`Mã khuyến mãi "${dto.code}" đã tồn tại`);

    return this.prisma.promotion.create({
      data: {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        description: dto.description,
        isActive: dto.isActive ?? false,
        status: dto.isActive ? 'running' : 'draft',
        priority: dto.priority ?? 0,
        stackable: dto.stackable ?? false,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        applyTimeFrom: dto.applyTimeFrom,
        applyTimeTo: dto.applyTimeTo,
        applyWeekdays: dto.applyWeekdays ?? [],
        forAllBranch: dto.forAllBranch ?? true,
        forAllCustomer: dto.forAllCustomer ?? true,
        forAllUser: dto.forAllUser ?? true,
        minOrderValue: dto.minOrderValue ?? 0,
        minQuantity: dto.minQuantity ?? 0,
        maxDiscountAmount: dto.maxDiscountAmount ?? null,
        maxRewardQuantity: dto.maxRewardQuantity ?? null,
        usageLimit: dto.usageLimit ?? null,
        autoApply: dto.autoApply ?? true,
        createdBy: userId,
        rewards: {
          create: (dto.rewards ?? []).map((r) => ({
            buyProductId: r.buyProductId ?? null,
            buyCategoryName: r.buyCategoryName ?? null,
            buyQuantity: r.buyQuantity ?? 0,
            rewardType: r.rewardType,
            rewardProductId: r.rewardProductId ?? null,
            rewardQuantity: r.rewardQuantity ?? 0,
            rewardValue: r.rewardValue ?? 0,
          })),
        },
        products: { create: this.buildProductRows(dto.rewards ?? []) },
        branches: dto.forAllBranch
          ? undefined
          : {
              create: (dto.branchIds ?? []).map((branchId) => ({ branchId })),
            },
        customers: dto.forAllCustomer
          ? undefined
          : {
              create: (dto.customerIds ?? []).map((customerId) => ({
                customerId,
              })),
            },
        customerGroups: dto.forAllCustomer
          ? undefined
          : {
              create: (dto.customerGroupIds ?? []).map((customerGroupId) => ({
                customerGroupId,
              })),
            },
        users: dto.forAllUser
          ? undefined
          : {
              create: (dto.userIds ?? []).map((userId2) => ({
                userId: userId2,
              })),
            },
      },
      include: {
        rewards: true,
        branches: true,
        customers: true,
        customerGroups: true,
        users: true,
        products: true,
      },
    });
  }

  async update(id: number, dto: UpdatePromotionDto, _userId: number) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo)
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');

    if (dto.code || dto.type || dto.rewards) {
      this.validatePayload({ ...promo, ...dto } as any);
    }
    // Validate phạm vi khi có gửi field scope
    if (
      dto.forAllBranch !== undefined ||
      dto.forAllCustomer !== undefined ||
      dto.forAllUser !== undefined
    ) {
      this.validateScope(dto);
    }

    if (dto.code && dto.code !== promo.code) {
      const dup = await this.prisma.promotion.findUnique({
        where: { code: dto.code },
      });
      if (dup)
        throw new BadRequestException(`Mã khuyến mãi "${dto.code}" đã tồn tại`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Replace rewards / scope nếu được gửi
      if (dto.rewards) {
        await tx.promotionReward.deleteMany({ where: { promotionId: id } });
        await tx.promotionProduct.deleteMany({ where: { promotionId: id } });
      }
      if (dto.branchIds !== undefined || dto.forAllBranch !== undefined) {
        await tx.promotionBranch.deleteMany({ where: { promotionId: id } });
      }
      if (dto.customerIds !== undefined || dto.forAllCustomer !== undefined) {
        await tx.promotionCustomer.deleteMany({ where: { promotionId: id } });
      }
      if (
        dto.customerGroupIds !== undefined ||
        dto.forAllCustomer !== undefined
      ) {
        await tx.promotionCustomerGroup.deleteMany({
          where: { promotionId: id },
        });
      }
      if (dto.userIds !== undefined || dto.forAllUser !== undefined) {
        await tx.promotionUser.deleteMany({ where: { promotionId: id } });
      }

      return tx.promotion.update({
        where: { id },
        data: {
          code: dto.code,
          name: dto.name,
          type: dto.type,
          description: dto.description,
          priority: dto.priority,
          stackable: dto.stackable,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          applyTimeFrom: dto.applyTimeFrom,
          applyTimeTo: dto.applyTimeTo,
          applyWeekdays: dto.applyWeekdays,
          forAllBranch: dto.forAllBranch,
          forAllCustomer: dto.forAllCustomer,
          forAllUser: dto.forAllUser,
          minOrderValue: dto.minOrderValue,
          minQuantity: dto.minQuantity,
          maxDiscountAmount: dto.maxDiscountAmount,
          maxRewardQuantity: dto.maxRewardQuantity,
          usageLimit: dto.usageLimit,
          autoApply: dto.autoApply,
          rewards: dto.rewards
            ? {
                create: dto.rewards.map((r) => ({
                  buyProductId: r.buyProductId ?? null,
                  buyCategoryName: r.buyCategoryName ?? null,
                  buyQuantity: r.buyQuantity ?? 0,
                  rewardType: r.rewardType,
                  rewardProductId: r.rewardProductId ?? null,
                  rewardQuantity: r.rewardQuantity ?? 0,
                  rewardValue: r.rewardValue ?? 0,
                })),
              }
            : undefined,
          products: dto.rewards
            ? { create: this.buildProductRows(dto.rewards) }
            : undefined,
          branches:
            dto.forAllBranch === false && dto.branchIds
              ? { create: dto.branchIds.map((branchId) => ({ branchId })) }
              : undefined,
          customers:
            dto.forAllCustomer === false && dto.customerIds
              ? {
                  create: dto.customerIds.map((customerId) => ({ customerId })),
                }
              : undefined,
          customerGroups:
            dto.forAllCustomer === false && dto.customerGroupIds
              ? {
                  create: dto.customerGroupIds.map((customerGroupId) => ({
                    customerGroupId,
                  })),
                }
              : undefined,
          users:
            dto.forAllUser === false && dto.userIds
              ? { create: dto.userIds.map((uId) => ({ userId: uId })) }
              : undefined,
        },
        include: {
          rewards: true,
          branches: true,
          customers: true,
          customerGroups: true,
          users: true,
          products: true,
        },
      });
    });
  }

  /** Dựng các dòng promotion_products từ rewards (buyItems → role 'buy', rewardItems → role 'reward'). */
  private buildProductRows(rewards: any[]) {
    const rows: {
      role: string;
      productId: number | null;
      categoryName: string | null;
    }[] = [];
    for (const r of rewards) {
      for (const b of r.buyItems ?? []) {
        rows.push({
          role: 'buy',
          productId: b.productId ?? null,
          categoryName: b.categoryName ?? null,
        });
      }
      for (const y of r.rewardItems ?? []) {
        rows.push({
          role: 'reward',
          productId: y.productId ?? null,
          categoryName: y.categoryName ?? null,
        });
      }
    }
    return rows;
  }

  async toggle(id: number, isActive: boolean) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: { rewards: true },
    });
    if (!promo)
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');
    if (isActive) {
      if (promo.rewards.length === 0)
        throw new BadRequestException(
          'Chương trình chưa có cấu hình phần thưởng',
        );
      if (promo.endDate && new Date() > promo.endDate)
        throw new BadRequestException('Chương trình đã hết hạn, không thể bật');
    }
    return this.prisma.promotion.update({
      where: { id },
      data: { isActive, status: isActive ? 'running' : 'paused' },
    });
  }

  async stop(id: number) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo)
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');
    return this.prisma.promotion.update({
      where: { id },
      data: { isActive: false, status: 'stopped' },
    });
  }

  async findAll(query: PromotionQueryDto) {
    const page = query.page || 1;
    const pageSize = query.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const where = this.buildPromotionWhere(query);

    const [data, total] = await this.prisma.$transaction([
      this.prisma.promotion.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          rewards: true,
          branches: true,
          _count: { select: { logs: true } },
        },
      }),
      this.prisma.promotion.count({ where }),
    ]);
    return { data, total };
  }

  /**
   * Dựng điều kiện `where` cho danh sách/xuất file khuyến mãi. Tách riêng để
   * dùng chung giữa findAll và export/export-detail — filter xuất file khớp
   * hoàn toàn với bộ lọc đang hiển thị trên UI.
   */
  private buildPromotionWhere(query: PromotionQueryDto): any {
    const where: any = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.branchId) {
      // branchId filter ghi đè OR search (giữ hành vi cũ của findAll).
      where.OR = [
        { forAllBranch: true },
        { branches: { some: { branchId: query.branchId } } },
      ];
    }
    return where;
  }

  /**
   * Xuất Excel TỔNG QUAN chương trình khuyến mãi (mỗi CTKM = 1 dòng). Bộ lọc
   * dùng chung buildPromotionWhere với danh sách.
   */
  async exportPromotions(
    query: PromotionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildPromotionWhere(query);

    const fmtDate = (d?: Date | null) =>
      d ? new Date(d).toLocaleDateString('vi-VN') : '';
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Khuyến mãi');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã', key: 'code', width: 16 },
      { header: 'Tên', key: 'name', width: 28 },
      { header: 'Loại', key: 'type', width: 22 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Bật', key: 'isActive', width: 10 },
      { header: 'Ưu tiên', key: 'priority', width: 10 },
      { header: 'Cộng dồn', key: 'stackable', width: 12 },
      { header: 'Tự áp dụng', key: 'autoApply', width: 12 },
      { header: 'Ngày bắt đầu', key: 'startDate', width: 14 },
      { header: 'Ngày kết thúc', key: 'endDate', width: 14 },
      { header: 'Giờ áp dụng từ', key: 'applyTimeFrom', width: 14 },
      { header: 'Giờ áp dụng đến', key: 'applyTimeTo', width: 14 },
      { header: 'Thứ áp dụng', key: 'applyWeekdays', width: 16 },
      { header: 'Áp dụng mọi CN', key: 'forAllBranch', width: 14 },
      { header: 'Áp dụng mọi KH', key: 'forAllCustomer', width: 14 },
      { header: 'Áp dụng mọi NV', key: 'forAllUser', width: 14 },
      { header: 'Đơn tối thiểu', key: 'minOrderValue', width: 14 },
      { header: 'SL tối thiểu', key: 'minQuantity', width: 12 },
      { header: 'Giảm tối đa', key: 'maxDiscountAmount', width: 14 },
      { header: 'SL quà tối đa', key: 'maxRewardQuantity', width: 14 },
      { header: 'Giới hạn lượt', key: 'usageLimit', width: 12 },
      { header: 'Đã dùng', key: 'usageCount', width: 10 },
      { header: 'Số reward', key: 'rewardCount', width: 10 },
      { header: 'Mô tả', key: 'description', width: 28 },
      { header: 'Ngày tạo', key: 'createdAt', width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.promotion.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          rewards: { select: { id: true } },
        },
      });

      if (batch.length === 0) break;

      for (const p of batch) {
        stt++;
        sheet
          .addRow({
            stt,
            code: p.code,
            name: p.name,
            type: PROMOTION_TYPE_LABELS[p.type] || p.type,
            status: PROMOTION_STATUS_LABELS[p.status] || p.status,
            isActive: p.isActive ? 'Bật' : 'Tắt',
            priority: p.priority,
            stackable: p.stackable ? 'Có' : 'Không',
            autoApply: p.autoApply ? 'Có' : 'Không',
            startDate: fmtDate(p.startDate),
            endDate: fmtDate(p.endDate),
            applyTimeFrom: p.applyTimeFrom || '',
            applyTimeTo: p.applyTimeTo || '',
            applyWeekdays: (p.applyWeekdays || []).join(', '),
            forAllBranch: p.forAllBranch ? 'Có' : 'Không',
            forAllCustomer: p.forAllCustomer ? 'Có' : 'Không',
            forAllUser: p.forAllUser ? 'Có' : 'Không',
            minOrderValue: Number(p.minOrderValue) || 0,
            minQuantity: Number(p.minQuantity) || 0,
            maxDiscountAmount:
              p.maxDiscountAmount != null ? Number(p.maxDiscountAmount) : '',
            maxRewardQuantity:
              p.maxRewardQuantity != null ? Number(p.maxRewardQuantity) : '',
            usageLimit: p.usageLimit ?? '',
            usageCount: p.usageCount,
            rewardCount: p.rewards.length,
            description: p.description || '',
            createdAt: fmtDateTime(p.createdAt),
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất Excel CHI TIẾT chương trình khuyến mãi.
   *
   * Mỗi dòng Excel = 1 cặp (reward, SP mua) — vì SP mua được lưu ở
   * `promotion_products` (role='buy') dạng mảng (buyItems), không còn chỉ
   * dựa vào field legacy `reward.buyProductId`. Nếu reward không có SP mua
   * (vd GIFT_BY_INVOICE) thì vẫn xuất 1 dòng với cột SP mua trống.
   */
  async exportPromotionsDetail(
    query: PromotionQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildPromotionWhere(query);

    const fmtDate = (d?: Date | null) =>
      d ? new Date(d).toLocaleDateString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết khuyến mãi');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã CTKM', key: 'code', width: 16 },
      { header: 'Tên CTKM', key: 'name', width: 28 },
      { header: 'Loại', key: 'type', width: 22 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Bật', key: 'isActive', width: 10 },
      { header: 'Ưu tiên', key: 'priority', width: 10 },
      { header: 'Ngày bắt đầu', key: 'startDate', width: 14 },
      { header: 'Ngày kết thúc', key: 'endDate', width: 14 },
      { header: 'Loại reward', key: 'rewardType', width: 16 },
      { header: 'Mã SP mua', key: 'buyProductCode', width: 14 },
      { header: 'Tên SP mua', key: 'buyProductName', width: 24 },
      { header: 'Nhóm SP mua', key: 'buyCategoryName', width: 18 },
      { header: 'SL mua', key: 'buyQuantity', width: 10 },
      { header: 'Mã SP tặng/KM', key: 'rewardProductCode', width: 14 },
      { header: 'Tên SP tặng/KM', key: 'rewardProductName', width: 24 },
      { header: 'Nhóm SP tặng/KM', key: 'rewardCategoryName', width: 18 },
      { header: 'SL tặng', key: 'rewardQuantity', width: 10 },
      { header: 'Giá trị KM', key: 'rewardValue', width: 12 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let stt = 0;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.promotion.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          rewards: {
            include: {
              buyProduct: { select: { code: true, name: true } },
              rewardProduct: { select: { code: true, name: true } },
            },
          },
          // SP mua / tặng hiện đại lưu ở đây (buyItems / rewardItems).
          products: {
            include: {
              product: { select: { code: true, name: true } },
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const p of batch) {
        const base = {
          code: p.code,
          name: p.name,
          type: PROMOTION_TYPE_LABELS[p.type] || p.type,
          status: PROMOTION_STATUS_LABELS[p.status] || p.status,
          isActive: p.isActive ? 'Bật' : 'Tắt',
          priority: p.priority,
          startDate: fmtDate(p.startDate),
          endDate: fmtDate(p.endDate),
        };

        // Gom SP mua / tặng từ promotion_products (nguồn chân lý hiện tại).
        const buyProducts = p.products
          .filter((pp) => pp.role === 'buy')
          .map((pp) => ({
            code: pp.product?.code || '',
            name: pp.product?.name || '',
            categoryName: pp.categoryName || '',
          }));
        const rewardProducts = p.products
          .filter((pp) => pp.role === 'reward')
          .map((pp) => ({
            code: pp.product?.code || '',
            name: pp.product?.name || '',
            categoryName: pp.categoryName || '',
          }));

        if (!p.rewards.length) {
          // Không có reward: vẫn xuất theo danh sách SP mua (nếu có).
          const rows =
            buyProducts.length > 0
              ? buyProducts
              : [{ code: '', name: '', categoryName: '' }];
          for (const buy of rows) {
            stt++;
            sheet
              .addRow({
                ...base,
                stt,
                rewardType: '',
                buyProductCode: buy.code,
                buyProductName: buy.name,
                buyCategoryName: buy.categoryName,
                buyQuantity: '',
                rewardProductCode: '',
                rewardProductName: '',
                rewardCategoryName: '',
                rewardQuantity: '',
                rewardValue: '',
              })
              .commit();
          }
          continue;
        }

        for (const r of p.rewards) {
          // Fallback legacy: nếu không có products role=buy thì dùng
          // reward.buyProduct / buyCategoryName.
          const buyList =
            buyProducts.length > 0
              ? buyProducts
              : [
                  {
                    code: r.buyProduct?.code || '',
                    name: r.buyProduct?.name || '',
                    categoryName: r.buyCategoryName || '',
                  },
                ];

          // SP tặng/KM: ưu tiên products role=reward; fallback rewardProduct.
          const giftList =
            rewardProducts.length > 0
              ? rewardProducts
              : [
                  {
                    code: r.rewardProduct?.code || '',
                    name: r.rewardProduct?.name || '',
                    categoryName: '',
                  },
                ];

          // Cartesian tối thiểu: mỗi SP mua × mỗi SP tặng (thường 1×1 hoặc N×1).
          // Khi cả 2 list rỗng → 1 dòng trống.
          const buys =
            buyList.length > 0
              ? buyList
              : [{ code: '', name: '', categoryName: '' }];
          const gifts =
            giftList.length > 0
              ? giftList
              : [{ code: '', name: '', categoryName: '' }];

          for (const buy of buys) {
            for (const gift of gifts) {
              stt++;
              sheet
                .addRow({
                  ...base,
                  stt,
                  rewardType: REWARD_TYPE_LABELS[r.rewardType] || r.rewardType,
                  buyProductCode: buy.code,
                  buyProductName: buy.name,
                  buyCategoryName: buy.categoryName,
                  buyQuantity: Number(r.buyQuantity) || 0,
                  rewardProductCode: gift.code,
                  rewardProductName: gift.name,
                  rewardCategoryName: gift.categoryName,
                  rewardQuantity: Number(r.rewardQuantity) || 0,
                  rewardValue: Number(r.rewardValue) || 0,
                })
                .commit();
            }
          }
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: {
        rewards: { include: { buyProduct: true, rewardProduct: true } },
        branches: true,
        customers: {
          include: {
            customer: { select: { id: true, name: true, phone: true } },
          },
        },
        customerGroups: true,
        users: true,
        products: { include: { product: true } },
      },
    });
    if (!promo)
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');
    return promo;
  }

  async getLogs(id: number) {
    return this.prisma.invoicePromotionLog.findMany({
      where: { promotionId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        invoice: { select: { id: true, code: true } },
        order: { select: { id: true, code: true } },
      },
    });
  }

  /** Danh sách đơn hàng / hóa đơn đã áp dụng KM (theo promotionId trên dòng hàng). */
  async getUsage(id: number) {
    const [orders, invoices] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where: {
          items: { some: { promotionId: id } },
          status: { not: ORDER_STATUS.CANCELLED },
        },
        select: {
          id: true,
          code: true,
          orderDate: true,
          status: true,
          statusValue: true,
        },
        orderBy: { orderDate: 'desc' },
        take: 200,
      }),
      this.prisma.invoice.findMany({
        where: {
          details: { some: { promotionId: id } },
          status: { not: INVOICE_STATUS.CANCELLED },
        },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          status: true,
          statusValue: true,
        },
        orderBy: { purchaseDate: 'desc' },
        take: 200,
      }),
    ]);
    return {
      orders: orders.map((o) => ({
        id: o.id,
        code: o.code,
        date: o.orderDate,
        status: o.status,
        statusValue: o.statusValue,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        code: i.code,
        date: i.purchaseDate,
        status: i.status,
        statusValue: i.statusValue,
      })),
    };
  }

  /**
   * Thống kê hàng bán / hàng khuyến mãi của 1 chương trình.
   * - Hàng bán: dòng lineType normal | promo_discount có gắn promotionId.
   * - Hàng KM: dòng lineType gift | discounted_buy.
   * CHỈ tính trên hóa đơn (invoice), KHÔNG tính đơn đặt hàng. Loại trừ HĐ Đã hủy.
   */
  async getStats(id: number) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      select: {
        id: true,
        usageLimit: true,
        usageCount: true,
        maxRewardQuantity: true,
      },
    });
    if (!promo)
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');

    const invoiceLines = await this.prisma.invoiceDetail.findMany({
      where: {
        promotionId: id,
        invoice: { status: { not: INVOICE_STATUS.CANCELLED } },
      },
      select: {
        productId: true,
        productCode: true,
        productName: true,
        quantity: true,
        lineType: true,
      },
    });

    const SOLD = new Set(['normal', 'promo_discount']);
    const PROMO = new Set(['gift', 'discounted_buy']);
    const map = new Map<
      number,
      {
        productId: number;
        code: string;
        name: string;
        soldQty: number;
        promoQty: number;
      }
    >();
    const addLine = (l: {
      productId: number | null;
      productCode: string;
      productName: string;
      quantity: any;
      lineType: string;
    }) => {
      if (l.productId == null) return;
      const key = l.productId;
      const row = map.get(key) || {
        productId: key,
        code: l.productCode,
        name: l.productName,
        soldQty: 0,
        promoQty: 0,
      };
      const qty = Number(l.quantity);
      if (SOLD.has(l.lineType)) row.soldQty += qty;
      else if (PROMO.has(l.lineType)) row.promoQty += qty;
      map.set(key, row);
    };
    invoiceLines.forEach(addLine);

    const items = [...map.values()].sort((a, b) => b.soldQty - a.soldQty);
    const totals = items.reduce(
      (acc, it) => ({
        soldQty: acc.soldQty + it.soldQty,
        promoQty: acc.promoQty + it.promoQty,
      }),
      { soldQty: 0, promoQty: 0 },
    );

    const usageLimit = promo.usageLimit;
    const usageCount = promo.usageCount;
    const maxRewardQuantity =
      promo.maxRewardQuantity != null ? Number(promo.maxRewardQuantity) : null;

    return {
      items,
      totals,
      limits: {
        usageLimit,
        usageCount,
        usageRemaining: usageLimit != null ? usageLimit - usageCount : null,
        maxRewardQuantity,
        rewardIssued: totals.promoQty,
        rewardRemaining:
          maxRewardQuantity != null
            ? maxRewardQuantity - totals.promoQty
            : null,
      },
    };
  }

  // --------------------------- EVALUATE ---------------------------
  async evaluate(dto: EvaluatePromotionDto) {
    if (!dto.items || dto.items.length === 0)
      throw new BadRequestException('Giỏ hàng trống');

    const now = dto.purchaseDate ? new Date(dto.purchaseDate) : new Date();
    const customerGroupIds = dto.customerId
      ? (
          await this.prisma.customerGroupDetail.findMany({
            where: { customerId: dto.customerId },
            select: { customerGroupId: true },
          })
        ).map((g) => g.customerGroupId)
      : [];

    const promotions = await this.loadCandidates(
      dto.branchId,
      dto.customerId ?? null,
      customerGroupIds,
      dto.userId ?? null,
    );

    const ctx = await this.buildContext(
      dto.branchId,
      dto.customerId ?? null,
      dto.userId ?? null,
      now,
      dto.items as EngineItem[],
      promotions,
    );

    const result = evaluatePromotions(promotions, ctx);
    return result;
  }

  /**
   * Dùng bởi InvoicesService khi tạo hóa đơn (re-validate trong transaction).
   * Trả về kết quả engine đã lọc theo appliedPromotionIds.
   */
  async evaluateForInvoice(params: {
    branchId: number;
    customerId?: number | null;
    userId?: number | null;
    purchaseDate?: Date;
    items: EngineItem[];
    appliedPromotionIds?: number[];
  }) {
    const now = params.purchaseDate || new Date();
    const customerGroupIds = params.customerId
      ? (
          await this.prisma.customerGroupDetail.findMany({
            where: { customerId: params.customerId },
            select: { customerGroupId: true },
          })
        ).map((g) => g.customerGroupId)
      : [];

    const promotions = await this.loadCandidates(
      params.branchId,
      params.customerId ?? null,
      customerGroupIds,
      params.userId ?? null,
    );
    const ctx = await this.buildContext(
      params.branchId,
      params.customerId ?? null,
      params.userId ?? null,
      now,
      params.items,
      promotions,
    );
    const evalResult = evaluatePromotions(promotions, ctx);

    // KM được áp: KM mà FE đã chọn (appliedPromotionIds).
    // KM loại sinh quà / mua kèm (BUY_X_GET_Y, BUY_N_GET_M_SAME,
    // BUY_X_BUY_Y_PRICE, GIFT_BY_INVOICE) chỉ áp khi opt-in — KHÔNG auto.
    // KM giảm giá (INVOICE/PRODUCT/CATEGORY_DISCOUNT) chỉ auto khi autoApply=true.
    // Nếu FE chọn (applyIds có id) thì vẫn áp, kể cả autoApply=false (user opt-in).
    const giftTypes = new Set([
      'BUY_X_GET_Y',
      'BUY_N_GET_M_SAME',
      'BUY_X_BUY_Y_PRICE',
      'GIFT_BY_INVOICE',
    ]);
    const applyIds = new Set(params.appliedPromotionIds ?? []);
    const applied = evalResult.eligiblePromotions.filter((r) => {
      if (applyIds.has(r.promotionId)) return true;
      if (giftTypes.has(r.type)) return false;
      return r.selected && r.autoApply && applyIds.size === 0;
    });
    return { ...evalResult, applied };
  }

  // --------------------------- HELPERS ----------------------------

  private async loadCandidates(
    branchId: number,
    customerId: number | null,
    customerGroupIds: number[],
    userId: number | null,
  ): Promise<EnginePromotion[]> {
    const now = new Date();
    const promos = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        status: 'running',
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
          {
            OR: [{ forAllBranch: true }, { branches: { some: { branchId } } }],
          },
          {
            OR: [
              { forAllCustomer: true },
              ...(customerId ? [{ customers: { some: { customerId } } }] : []),
              ...(customerGroupIds.length
                ? [
                    {
                      customerGroups: {
                        some: { customerGroupId: { in: customerGroupIds } },
                      },
                    },
                  ]
                : []),
            ],
          },
          {
            OR: [
              { forAllUser: true },
              ...(userId ? [{ users: { some: { userId } } }] : []),
            ],
          },
        ],
      },
      include: { rewards: true, products: true },
      orderBy: { priority: 'desc' },
    });

    return promos.map((p) => {
      const buyItems = p.products
        .filter((pp) => pp.role === 'buy')
        .map((pp) => ({
          productId: pp.productId,
          categoryName: pp.categoryName,
        }));
      const rewardItems = p.products
        .filter((pp) => pp.role === 'reward')
        .map((pp) => ({
          productId: pp.productId,
          categoryName: pp.categoryName,
        }));
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        type: p.type,
        priority: p.priority,
        stackable: p.stackable,
        autoApply: p.autoApply,
        startDate: p.startDate,
        endDate: p.endDate,
        applyTimeFrom: p.applyTimeFrom,
        applyTimeTo: p.applyTimeTo,
        applyWeekdays: p.applyWeekdays,
        minOrderValue: Number(p.minOrderValue),
        minQuantity: Number(p.minQuantity),
        maxDiscountAmount:
          p.maxDiscountAmount != null ? Number(p.maxDiscountAmount) : null,
        maxRewardQuantity:
          p.maxRewardQuantity != null ? Number(p.maxRewardQuantity) : null,
        usageLimit: p.usageLimit,
        usageCount: p.usageCount,
        rewards: p.rewards.map((r) => ({
          buyProductId: r.buyProductId,
          buyCategoryName: r.buyCategoryName,
          buyQuantity: Number(r.buyQuantity),
          rewardType: r.rewardType,
          rewardProductId: r.rewardProductId,
          rewardQuantity: Number(r.rewardQuantity),
          rewardValue: Number(r.rewardValue),
          buyItems: buyItems.length ? buyItems : undefined,
          rewardItems: rewardItems.length ? rewardItems : undefined,
        })),
      };
    });
  }

  private async buildContext(
    branchId: number,
    customerId: number | null,
    userId: number | null,
    now: Date,
    items: EngineItem[],
    promotions: EnginePromotion[],
  ): Promise<EngineContext> {
    // Tập hợp productId + categoryName cần biết
    const productIds = new Set<number>();
    const categoryNames = new Set<string>();
    items.forEach((it) => productIds.add(it.productId));
    promotions.forEach((p) =>
      p.rewards.forEach((r) => {
        if (r.buyProductId) productIds.add(r.buyProductId);
        if (r.rewardProductId) productIds.add(r.rewardProductId);
        (r.buyItems ?? []).forEach((b) => {
          if (b.productId) productIds.add(b.productId);
          if (b.categoryName) categoryNames.add(b.categoryName);
        });
        (r.rewardItems ?? []).forEach((y) => {
          if (y.productId) productIds.add(y.productId);
          if (y.categoryName) categoryNames.add(y.categoryName);
        });
      }),
    );

    // Resolve các SP thuộc category (parent/middle/child name)
    const categoryProductMap: Record<string, number[]> = {};
    if (categoryNames.size > 0) {
      const catList = [...categoryNames];
      const catProducts = await this.prisma.product.findMany({
        where: {
          isActive: true,
          OR: [
            { parentName: { in: catList } },
            { middleName: { in: catList } },
            { childName: { in: catList } },
          ],
        },
        select: {
          id: true,
          name: true,
          parentName: true,
          middleName: true,
          childName: true,
        },
      });
      for (const cp of catProducts) {
        productIds.add(cp.id);
        for (const name of catList) {
          if (
            cp.parentName === name ||
            cp.middleName === name ||
            cp.childName === name
          ) {
            (categoryProductMap[name] ||= []).push(cp.id);
          }
        }
      }
    }
    const ids = [...productIds];

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        code: true,
        parentName: true,
        middleName: true,
        childName: true,
      },
    });
    const productNameMap: Record<number, string> = {};
    const productCodeMap: Record<number, string> = {};
    const catMap: Record<number, any> = {};
    products.forEach((p) => {
      productNameMap[p.id] = p.name;
      productCodeMap[p.id] = p.code;
      catMap[p.id] = p;
    });

    // Tồn kho (onHand) tại branch cho các productId
    const inventories = await this.prisma.inventory.findMany({
      where: { branchId, productId: { in: ids } },
      select: { productId: true, onHand: true },
    });
    const stockMap: Record<number, number> = {};
    inventories.forEach((inv) => {
      stockMap[inv.productId] = Number(inv.onHand);
    });

    // Bổ sung category cho item trong giỏ (để engine match CATEGORY_DISCOUNT)
    const enrichedItems: EngineItem[] = items.map((it) => ({
      ...it,
      parentName: catMap[it.productId]?.parentName ?? null,
      middleName: catMap[it.productId]?.middleName ?? null,
      childName: catMap[it.productId]?.childName ?? null,
    }));

    return {
      branchId,
      customerId,
      userId,
      now,
      items: enrichedItems,
      stockMap,
      productNameMap,
      productCodeMap,
      categoryProductMap,
    };
  }

  /**
   * Validate phạm vi áp dụng: nếu chọn "cụ thể" (forAll* = false) thì
   * danh sách tương ứng không được rỗng — tránh KM bị vô hiệu âm thầm.
   */
  private validateScope(dto: Partial<CreatePromotionDto>) {
    if (
      dto.forAllBranch === false &&
      !(dto.branchIds && dto.branchIds.length > 0)
    )
      throw new BadRequestException(
        'Đã chọn áp dụng chi nhánh cụ thể — vui lòng chọn ít nhất 1 chi nhánh',
      );
    if (
      dto.forAllCustomer === false &&
      !(dto.customerIds && dto.customerIds.length > 0) &&
      !(dto.customerGroupIds && dto.customerGroupIds.length > 0)
    )
      throw new BadRequestException(
        'Đã chọn áp dụng khách hàng/nhóm cụ thể — vui lòng chọn ít nhất 1 khách hàng hoặc nhóm khách hàng',
      );
    if (dto.forAllUser === false && !(dto.userIds && dto.userIds.length > 0))
      throw new BadRequestException(
        'Đã chọn áp dụng người tạo giao dịch cụ thể — vui lòng chọn ít nhất 1 người',
      );
  }

  private validatePayload(dto: CreatePromotionDto) {
    if (dto.startDate && dto.endDate) {
      if (new Date(dto.endDate) <= new Date(dto.startDate))
        throw new BadRequestException('Ngày kết thúc phải sau ngày bắt đầu');
    }
    const rewards = dto.rewards ?? [];
    if (rewards.length === 0)
      throw new BadRequestException('Cần ít nhất 1 cấu hình phần thưởng');

    const rw = rewards[0];
    const hasBuy = !!(
      rw.buyProductId ||
      rw.buyCategoryName ||
      (rw.buyItems && rw.buyItems.length > 0)
    );
    const hasReward = !!(
      rw.rewardProductId ||
      (rw.rewardItems && rw.rewardItems.length > 0)
    );
    switch (dto.type) {
      case 'BUY_X_GET_Y':
        if (!hasBuy || !rw.buyQuantity || !hasReward || !rw.rewardQuantity)
          throw new BadRequestException(
            'Mua X tặng Y cần: sản phẩm/nhóm mua, số lượng mua, sản phẩm/nhóm tặng, số lượng tặng',
          );
        break;
      case 'BUY_N_GET_M_SAME':
        if (!hasBuy || !rw.buyQuantity || !rw.rewardQuantity)
          throw new BadRequestException(
            'Mua N tặng M cùng loại cần: sản phẩm/nhóm, số lượng mua, số lượng tặng',
          );
        break;
      case 'BUY_X_BUY_Y_PRICE':
        if (!hasBuy || !rw.buyQuantity || !hasReward || rw.rewardValue == null)
          throw new BadRequestException(
            'Mua X mua kèm Y giá KM cần: sản phẩm/nhóm mua, số lượng mua, sản phẩm/nhóm mua kèm, giá khuyến mãi',
          );
        break;
      case 'INVOICE_DISCOUNT':
        if (rw.rewardValue == null || rw.rewardValue <= 0)
          throw new BadRequestException(
            'Giảm giá hóa đơn cần giá trị giảm > 0',
          );
        break;
      case 'PRODUCT_DISCOUNT':
        if (!rw.buyProductId || rw.rewardValue == null)
          throw new BadRequestException(
            'Giảm giá hàng hóa cần: sản phẩm và giá trị giảm',
          );
        break;
      case 'CATEGORY_DISCOUNT':
        if (!rw.buyCategoryName || rw.rewardValue == null)
          throw new BadRequestException(
            'Giảm giá theo nhóm hàng cần: tên nhóm và giá trị giảm',
          );
        break;
      case 'GIFT_BY_INVOICE':
        if (!rw.rewardProductId || !rw.rewardQuantity)
          throw new BadRequestException(
            'Quà tặng theo hóa đơn cần: sản phẩm tặng và số lượng',
          );
        break;
    }
  }
}
