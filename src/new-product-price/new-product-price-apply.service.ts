import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { NewProductPriceTicket, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { FactoryProductsService } from '../factory-products/factory-products.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import { loadUnitNameMap, resolveUnitFromMap } from '../common/unit.util';
import {
  BASE_PRICE_TARGET,
  COST_GROUP_FIELD,
  COST_GROUP_KEYS,
  COST_GROUP_LABELS,
  CostGroupKey,
  NPP_ACTION,
  NPP_EVENT,
  NPP_STAGE,
  PRICE_TARGET_FIELD,
  PRICE_TARGET_KEYS,
  PRICE_TARGET_LABELS,
} from './new-product-price.constants';
import { computeStatus, resolveAccess } from './new-product-price.rules';
import { toNum } from './new-product-price.calc';
import {
  NewProductPriceConfigService,
  NppConfig,
} from './new-product-price-config.service';
import { NewProductPriceNotifyService } from './new-product-price-notify.service';
import { NewProductPriceService, NppUser } from './new-product-price.service';

export interface ApplyIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ApplyPlan {
  product: {
    code: string | null;
    name: string;
    parentName: string | null;
    middleName: string | null;
    childName: string | null;
    tradeMarkId: number | null;
    tradeMarkName: string | null;
    unit: string | null;
    weight: number | null;
    basePrice: number | null;
    /** Định lượng đóng gói (1 thùng = n đơn vị) ← Quy cách đóng gói. */
    conversionValue: number | null;
    misaCode: string | null;
    misaName: string | null;
    misaUnit: string | null;
    imageCount: number;
    documentCount: number;
  };
  costs: {
    group: CostGroupKey;
    label: string;
    cost: number | null;
    branches: { id: number; name: string }[];
  }[];
  /** Chi nhánh không thuộc nhóm nào → nhận giá vốn Hà Nội (lúc tạo sản phẩm). */
  otherBranchesCost: number | null;
  prices: {
    key: string;
    label: string;
    price: number;
    priceBookId: number | null;
    priceBookName: string;
  }[];
  /** Gắn nhà máy như trang Nhà máy (giá tham chiếu, tiền tệ, tỉ giá, MOQ). */
  factory: {
    id: number;
    name: string;
    code: string | null;
    supplierName: string | null;
    role: 'primary';
    referencePrice: number | null;
    currency: string;
    exchangeRate: number | null;
    moqValue: number | null;
    moqUnit: 'CARTON' | null;
  } | null;
}

export interface ApplyPreview {
  ok: boolean;
  issues: ApplyIssue[];
  plan: ApplyPlan;
  alreadyCreated: boolean;
}

/** Thời gian coi một lần áp dụng dang dở là bỏ dở (cho phép người khác áp dụng lại). */
const CLAIM_TTL_MS = 5 * 60 * 1000;

interface Attachment {
  url: string;
  originalName?: string | null;
  mimetype?: string | null;
  size?: number | null;
  isPrimary?: boolean;
}

function asList(value: Prisma.JsonValue | null): Attachment[] {
  return Array.isArray(value)
    ? (value as unknown as Attachment[]).filter((a) => a?.url)
    : [];
}

/** "Áp dụng tạo sản phẩm mới" ở bước Phòng Dữ Liệu. */
@Injectable()
export class NewProductPriceApplyService {
  private readonly logger = new Logger(NewProductPriceApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nppConfig: NewProductPriceConfigService,
    private readonly products: ProductsService,
    private readonly larkProductSync: LarkProductSyncService,
    private readonly notify: NewProductPriceNotifyService,
    private readonly service: NewProductPriceService,
    private readonly factoryProducts: FactoryProductsService,
  ) {}

  async preview(id: number): Promise<ApplyPreview> {
    const [ticket, cfg] = await Promise.all([
      this.service.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    return this.buildPreview(ticket, cfg);
  }

  async buildPreview(
    ticket: NewProductPriceTicket,
    cfg: NppConfig,
  ): Promise<ApplyPreview> {
    const issues: ApplyIssue[] = [];
    const err = (field: string, message: string) =>
      issues.push({ field, message, severity: 'error' });
    const warn = (field: string, message: string) =>
      issues.push({ field, message, severity: 'warning' });
    const alreadyCreated = !!ticket.productId;

    if (ticket.stage !== NPP_STAGE.DATA) {
      err('stage', 'Phiếu chưa tới bước Phòng Dữ Liệu');
    }
    if (!ticket.productName?.trim()) err('productName', 'Chưa có tên hàng hóa');

    if (!alreadyCreated) {
      for (const [field, type, label, required] of [
        ['parentName', 'parent', 'Loại hàng', true],
        ['middleName', 'middle', 'Nguồn gốc hàng', false],
        ['childName', 'child', 'Danh mục hàng', true],
      ] as const) {
        const value = ticket[field];
        if (!value) {
          if (required) err(field, `Chưa chọn ${label}`);
          else warn(field, `Chưa chọn ${label}`);
          continue;
        }
        const found = await this.prisma.category.findFirst({
          where: { type, name: value },
          select: { id: true },
        });
        if (!found)
          err(field, `${label} "${value}" không có trong danh mục POS`);
      }

      if (!ticket.tradeMarkId) {
        err(
          'tradeMarkId',
          ticket.tradeMarkName
            ? `Thương hiệu "${ticket.tradeMarkName}" chưa có trong danh mục POS`
            : 'Chưa chọn Thương hiệu',
        );
      } else {
        const tm = await this.prisma.tradeMark.findUnique({
          where: { id: ticket.tradeMarkId },
          select: { id: true },
        });
        if (!tm) err('tradeMarkId', 'Thương hiệu không còn tồn tại');
      }

      if (!ticket.unit) {
        err('unit', 'Chưa chọn Đơn vị tính');
      } else {
        const resolved = resolveUnitFromMap(
          await loadUnitNameMap(this.prisma),
          ticket.unit,
        );
        if (resolved.unknown)
          err(
            'unit',
            `Đơn vị tính "${ticket.unit}" không có trong danh mục POS`,
          );
      }

      const sameName = await this.prisma.product.count({
        where: {
          isActive: true,
          name: { equals: ticket.productName.trim(), mode: 'insensitive' },
        },
      });
      if (sameName)
        warn('productName', `Đã có ${sameName} sản phẩm đang bán trùng tên`);
    }

    // Giá vốn theo nhóm chi nhánh.
    const allBranches = await this.prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    const branchName = new Map(allBranches.map((b) => [b.id, b.name]));
    const costs: ApplyPlan['costs'] = COST_GROUP_KEYS.map((group) => {
      const cost = toNum(
        ticket[COST_GROUP_FIELD[group] as keyof NewProductPriceTicket] as any,
      );
      const branches = cfg.costBranches[group]
        .filter((bid) => branchName.has(bid))
        .map((bid) => ({ id: bid, name: branchName.get(bid)! }));
      if (cost === null)
        err(COST_GROUP_FIELD[group], `Chưa có ${COST_GROUP_LABELS[group]}`);
      else if (!branches.length && group !== 'HN') {
        // POS có thể không có chi nhánh tương ứng (vd chưa có cửa hàng Diệp Trà)
        // → không chặn; giá vốn chỉ lưu trên phiếu.
        warn(
          'costBranches',
          `Chưa có chi nhánh nhận ${COST_GROUP_LABELS[group]} — giá vốn này chỉ lưu trên phiếu (Cấu hình duyệt → Áp dụng giá & giá vốn)`,
        );
      }
      return { group, label: COST_GROUP_LABELS[group], cost, branches };
    });

    // Giá bán → bảng giá đích.
    const targetIds = PRICE_TARGET_KEYS.map((k) => cfg.priceTargets[k]).filter(
      (t): t is number => typeof t === 'number',
    );
    if (ticket.oemPriceBookId) targetIds.push(ticket.oemPriceBookId);
    const books = targetIds.length
      ? await this.prisma.priceBook.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, name: true },
        })
      : [];
    const bookName = new Map(books.map((b) => [b.id, b.name]));

    const prices: ApplyPlan['prices'] = [];
    let basePrice: number | null = null;
    for (const key of PRICE_TARGET_KEYS) {
      const price = toNum(
        ticket[PRICE_TARGET_FIELD[key] as keyof NewProductPriceTicket] as any,
      );
      if (price === null || price <= 0) continue;
      const target = cfg.priceTargets[key];
      if (target === BASE_PRICE_TARGET) {
        basePrice = price;
        prices.push({
          key,
          label: PRICE_TARGET_LABELS[key],
          price,
          priceBookId: null,
          priceBookName: 'Bảng giá chung',
        });
      } else if (typeof target === 'number' && bookName.has(target)) {
        prices.push({
          key,
          label: PRICE_TARGET_LABELS[key],
          price,
          priceBookId: target,
          priceBookName: bookName.get(target)!,
        });
      } else {
        err(
          'priceTargets',
          `Chưa cấu hình bảng giá nhận "${PRICE_TARGET_LABELS[key]}"`,
        );
      }
    }
    const oemPrice = toNum(ticket.priceOem);
    if (oemPrice && oemPrice > 0) {
      if (ticket.oemPriceBookId && bookName.has(ticket.oemPriceBookId)) {
        prices.push({
          key: 'OEM',
          label: 'Giá OEM',
          price: oemPrice,
          priceBookId: ticket.oemPriceBookId,
          priceBookName: bookName.get(ticket.oemPriceBookId)!,
        });
      } else {
        warn(
          'oemPriceBookId',
          ticket.oemPriceBookName
            ? `Bảng giá OEM "${ticket.oemPriceBookName}" chưa có trên POS — bỏ qua Giá OEM`
            : 'Có Giá OEM nhưng chưa chọn Bảng giá OEM — bỏ qua',
        );
      }
    }
    if (basePrice === null && !alreadyCreated) {
      warn(
        'priceHnRetail',
        'Chưa có giá cho "Bảng giá chung" — giá bán chung sẽ là 0',
      );
    }

    // Mã Misa phải có trong danh mục vật tư Misa (giống "Liên kết Misa" ở form sản phẩm).
    let misaName: string | null = null;
    let misaUnit: string | null = null;
    if (ticket.misaCode) {
      const item = await this.prisma.misaInventoryItem.findFirst({
        where: { inventoryItemCode: ticket.misaCode, inactive: false },
        select: { inventoryItemName: true, unitName: true },
      });
      if (item) {
        misaName = item.inventoryItemName;
        misaUnit = item.unitName;
      } else {
        err(
          'misaCode',
          `Mã Misa "${ticket.misaCode}" không có trong danh mục Misa — chọn lại ở "Chuẩn hóa thông tin"`,
        );
      }
    }

    // Nhà máy: gắn với sản phẩm như trang Nhà máy; NCC đi theo nhà máy.
    let factory: ApplyPlan['factory'] = null;
    if (ticket.factoryId) {
      const f = await this.prisma.factory.findUnique({
        where: { id: ticket.factoryId },
        select: {
          id: true,
          name: true,
          code: true,
          currency: true,
          isActive: true,
          supplier: { select: { name: true } },
        },
      });
      if (!f?.isActive) {
        err('factoryId', 'Nhà máy đã chọn không còn hoạt động — chọn lại');
      } else {
        const currency = (f.currency || 'VND').toUpperCase();
        const exchangeRate =
          toNum(ticket.exchangeRate) ?? (currency === 'VND' ? 1 : null);
        const moqValue = toNum(ticket.moqCartons);
        factory = {
          id: f.id,
          name: f.name,
          code: f.code,
          supplierName: f.supplier?.name ?? ticket.supplierName ?? null,
          role: 'primary',
          referencePrice: toNum(ticket.goodsPrice),
          currency,
          exchangeRate,
          moqValue,
          moqUnit: moqValue !== null ? 'CARTON' : null,
        };
        if (currency !== 'VND' && exchangeRate === null) {
          warn(
            'exchangeRate',
            `Chưa có tỉ giá ${currency} — giá tham chiếu nhà máy chưa quy đổi được VND`,
          );
        }
      }
    } else if (ticket.supplierFactory) {
      warn(
        'factoryId',
        `Chưa chọn nhà máy (Lark ghi "${ticket.supplierFactory}") — sản phẩm sẽ không gắn nhà máy`,
      );
    } else if (ticket.supplierId) {
      warn(
        'factoryId',
        'Đã chọn NCC nhưng chưa chọn nhà máy — sản phẩm chỉ gắn được với nhà máy, NCC chỉ lưu trên phiếu',
      );
    }

    if (ticket.misaCode) {
      const dup = await this.prisma.product.count({
        where: {
          misa_code: ticket.misaCode,
          ...(ticket.productId ? { id: { not: ticket.productId } } : {}),
        },
      });
      if (dup)
        warn(
          'misaCode',
          `Mã Misa "${ticket.misaCode}" đã gán cho ${dup} sản phẩm khác`,
        );
    }

    const images = asList(ticket.images);
    const documents = asList(ticket.documents);
    const packing = toNum(ticket.packingSpec);
    return {
      ok: !issues.some((i) => i.severity === 'error'),
      issues,
      alreadyCreated,
      plan: {
        product: {
          code: ticket.productCode,
          name: ticket.productName,
          parentName: ticket.parentName,
          middleName: ticket.middleName,
          childName: ticket.childName,
          tradeMarkId: ticket.tradeMarkId,
          tradeMarkName: ticket.tradeMarkName,
          unit: ticket.unit,
          weight: toNum(ticket.netWeightGram),
          basePrice,
          conversionValue: packing && packing > 0 ? packing : null,
          misaCode: ticket.misaCode,
          misaName,
          misaUnit,
          imageCount: images.length,
          documentCount: documents.length,
        },
        costs,
        otherBranchesCost: toNum(ticket.cogsHn),
        prices,
        factory,
      },
    };
  }

  async apply(id: number, user: NppUser) {
    const [ticket, cfg] = await Promise.all([
      this.service.getTicketOrThrow(id),
      this.nppConfig.get(),
    ]);
    const access = resolveAccess(
      ticket as any,
      this.service.actorOf(user),
      cfg.approvers,
    );
    if (!access.actions.includes(NPP_ACTION.APPLY)) {
      throw new ForbiddenException(
        'Bạn không có quyền áp dụng tạo sản phẩm cho phiếu này',
      );
    }
    const preview = await this.buildPreview(ticket, cfg);
    if (!preview.ok) {
      const errors = preview.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message);
      throw new BadRequestException(
        `Chưa thể tạo sản phẩm: ${errors.join('; ')}`,
      );
    }

    let productId = ticket.productId;
    let productCode = ticket.productCode;

    // Bước 1 — tạo sản phẩm (chỉ khi chưa tạo; lần áp dụng lại bỏ qua bước này).
    if (!productId) {
      const now = new Date();
      const claim = await this.prisma.newProductPriceTicket.updateMany({
        where: {
          id,
          stage: NPP_STAGE.DATA,
          productId: null,
          OR: [
            { appliedById: null },
            { appliedAt: { lt: new Date(now.getTime() - CLAIM_TTL_MS) } },
          ],
        },
        data: {
          appliedById: user.id,
          appliedByName: user.name ?? null,
          appliedAt: now,
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException(
          'Phiếu đang được áp dụng, vui lòng đợi rồi tải lại',
        );
      }

      try {
        const images = asList(ticket.images);
        const primary = images.find((i) => i.isPrimary) ?? images[0];
        const created: any = await this.products.create(
          {
            code: '',
            name: ticket.productName.trim(),
            description: ticket.description ?? undefined,
            parentName: ticket.parentName ?? undefined,
            middleName: ticket.middleName ?? undefined,
            childName: ticket.childName ?? undefined,
            tradeMarkId: ticket.tradeMarkId ?? undefined,
            unit: ticket.unit ?? undefined,
            weight: toNum(ticket.netWeightGram) ?? undefined,
            weightUnit: 'g',
            ...(preview.plan.product.conversionValue
              ? { conversionValue: preview.plan.product.conversionValue }
              : {}),
            type: 2,
            basePrice: preview.plan.product.basePrice ?? 0,
            purchasePrice: toNum(ticket.cogsHn) ?? 0,
            costScope: 'all',
            imageUrls: images.map((i) => i.url),
            primaryImageUrl: primary?.url,
            documents: asList(ticket.documents).map((d) => ({
              url: d.url,
              originalName: d.originalName ?? undefined,
              mimetype: d.mimetype ?? undefined,
              size: d.size ?? undefined,
            })),
          } as any,
          user.id,
        );
        productId = created.id as number;
        productCode = created.code as string;
      } catch (error) {
        await this.prisma.newProductPriceTicket.updateMany({
          where: { id, productId: null, appliedById: user.id },
          data: { appliedById: null, appliedByName: null, appliedAt: null },
        });
        throw error;
      }

      // Lưu ngay để lần áp dụng lại (nếu bước 2 lỗi) không tạo sản phẩm trùng.
      await this.prisma.newProductPriceTicket.update({
        where: { id },
        data: {
          productId,
          productCode,
          applyResult: {
            product: {
              id: productId,
              code: productCode,
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
    }

    // Bước 1b — gắn nhà máy (giống trang Nhà máy: giá tham chiếu, tiền tệ, tỉ giá, MOQ,
    // lịch sử giá). Đã gắn rồi (áp dụng lại) thì bỏ qua.
    const fp = preview.plan.factory;
    let factoryLink: Record<string, unknown> | null = null;
    if (fp) {
      const existing = await this.prisma.factory_products.findUnique({
        where: {
          factoryId_productId: { factoryId: fp.id, productId },
        },
        select: { id: true },
      });
      if (!existing) {
        await this.factoryProducts.create(
          {
            factoryId: fp.id,
            productId,
            role: fp.role,
            priority: 0,
            referencePrice: fp.referencePrice,
            currency: fp.currency,
            exchangeRate: fp.exchangeRate,
            moq: fp.moqValue,
            moqValue: fp.moqValue,
            moqUnit: fp.moqUnit,
            moqBasis: fp.moqUnit ? 'QUANTITY' : null,
            reason: `Áp dụng từ phiếu bảng giá SP mới ${ticket.code}`,
          },
          user.id,
          user.name ?? null,
        );
      }
      factoryLink = {
        factoryId: fp.id,
        factoryName: fp.name,
        referencePrice: fp.referencePrice,
        currency: fp.currency,
        exchangeRate: fp.exchangeRate,
        moqValue: fp.moqValue,
        moqUnit: fp.moqUnit,
        alreadyLinked: !!existing,
      };
    }

    // Bước 2 — giá vốn theo chi nhánh, mã Misa, giá bán vào các bảng giá, đóng phiếu.
    const now = new Date();
    const costResults: {
      group: string;
      branchIds: number[];
      cost: number;
      updated: number;
    }[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const c of preview.plan.costs) {
        if (c.cost === null || !c.branches.length) continue;
        const res = await tx.inventory.updateMany({
          where: {
            productId: productId!,
            branchId: { in: c.branches.map((b) => b.id) },
          },
          data: { cost: c.cost },
        });
        costResults.push({
          group: c.group,
          branchIds: c.branches.map((b) => b.id),
          cost: c.cost,
          updated: res.count,
        });
      }

      const productData: Prisma.ProductUpdateInput = {};
      if (ticket.misaCode) {
        // ProductsService.create không lưu misa_* → ghi ở đây (đủ mã, tên, đơn vị Misa)
        productData.misa_code = ticket.misaCode;
        productData.misa_name = preview.plan.product.misaName ?? '';
        productData.misa_unit = preview.plan.product.misaUnit ?? '';
      }
      if (preview.plan.product.basePrice !== null)
        productData.basePrice = preview.plan.product.basePrice;
      if (Object.keys(productData).length) {
        await tx.product.update({
          where: { id: productId! },
          data: productData,
        });
      }

      for (const p of preview.plan.prices) {
        if (!p.priceBookId) continue;
        await tx.priceBookDetail.upsert({
          where: {
            priceBookId_productId: {
              priceBookId: p.priceBookId,
              productId: productId!,
            },
          },
          create: {
            priceBookId: p.priceBookId,
            productId: productId!,
            price: p.price,
          },
          update: { price: p.price, isActive: true },
        });
      }

      const applyResult = {
        product: { id: productId, code: productCode },
        costs: costResults,
        prices: preview.plan.prices,
        misaCode: ticket.misaCode,
        factory: factoryLink,
        appliedAt: now,
      };
      const res = await tx.newProductPriceTicket.updateMany({
        where: { id, stage: NPP_STAGE.DATA },
        data: {
          stage: NPP_STAGE.DONE,
          status: computeStatus({ ...ticket, stage: NPP_STAGE.DONE } as any),
          stageEnteredAt: now,
          doneAt: now,
          applyResult: applyResult as any,
          appliedAt: now,
          appliedById: user.id,
          appliedByName: user.name ?? null,
          updatedById: user.id,
          updatedByName: user.name ?? null,
        },
      });
      if (res.count !== 1)
        throw new ConflictException('Phiếu đã được cập nhật, vui lòng tải lại');
      await tx.newProductPriceEvent.create({
        data: {
          ticketId: id,
          type: NPP_EVENT.APPLIED,
          fromStage: NPP_STAGE.DATA,
          toStage: NPP_STAGE.DONE,
          content: `Tạo sản phẩm ${productCode}`,
          data: applyResult as any,
          actorId: user.id,
          actorName: user.name ?? null,
        },
      });
    });

    // Giá vốn/giá bán đổi sau lúc tạo → đồng bộ lại sang Lark Base sản phẩm.
    this.larkProductSync.enqueueSync(productId!);
    this.service.audit(
      ticket,
      user,
      'new_product_price.apply',
      `Áp dụng tạo sản phẩm ${productCode} từ phiếu ${ticket.code}`,
    );
    this.notify.send('PRODUCT_CREATED', id, { actorId: user.id });
    return this.service.findOne(id, user);
  }
}
