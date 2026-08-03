import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OrdersService } from '../orders/orders.service';
import { OrderSuppliersService } from '../order-suppliers/order-suppliers.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import {
  computeBucketTotals,
  computeBucketTotalsBatch,
  computeNearExpiryLots,
} from '../common/stock-condition-onhand.util';
import {
  getActiveLogKeys,
  isLogActive,
  computeOnHandFromLogs,
  recalcStockAuditChain,
} from '../common/inventory-onhand.util';
import { searchProductIds } from '../common/product-search.util';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import { StockAuditsService } from '../stock-audits/stock-audits.service';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private ordersService: OrdersService,
    private orderSuppliersService: OrderSuppliersService,
    private larkProductSync: LarkProductSyncService,
    private stockAuditsService: StockAuditsService,
  ) {}

  private parseAttributes(
    attributesText: string | null,
  ): { name: string; value: string }[] {
    if (!attributesText) return [];
    return attributesText.split('|').map((attr) => {
      const [name, value] = attr.split(':');
      return { name: name?.trim() || '', value: value?.trim() || '' };
    });
  }

  private buildFullName(name: string, attributesText: string | null): string {
    if (!attributesText) return name;

    const attrs = this.parseAttributes(attributesText);
    if (attrs.length === 0) return name;

    const attrValues = attrs.map((attr) => attr.value).join(' - ');
    return `${name} - ${attrValues}`;
  }

  private calculateTotalWeight(
    weight: any,
    weightUnit: string | null | undefined,
    onHand: any,
  ): number {
    const weightValue = weight ? Number(weight) : 0;
    const onHandValue = onHand ? Number(onHand) : 0;

    if (weightValue === 0) return 0;

    return weightValue * onHandValue;
  }

  private async syncTotalWeightToInventories(
    productId: number,
    weight: any,
    weightUnit: string | null | undefined,
    tx: any,
  ) {
    const inventories = await tx.inventory.findMany({
      where: { productId },
      select: { branchId: true, onHand: true },
    });

    for (const inv of inventories) {
      const totalWeight = this.calculateTotalWeight(
        weight,
        weightUnit,
        inv.onHand,
      );

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId,
            branchId: inv.branchId,
          },
        },
        data: { totalWeight },
      });
    }
  }

  private calculateManufacturingCost(
    components: {
      componentProductId: number;
      quantity: number;
      inputMode?: string;
    }[],
    componentProducts: any[],
    costMap: Map<number, number>,
    productType: number,
  ): number {
    return components.reduce((sum, comp) => {
      const componentCost = costMap.get(comp.componentProductId) || 0;
      const quantity = Number(comp.quantity);

      if (productType === 4) {
        // ─── PIECE / CARTON MODE ──────────────────────────────────
        // Tính theo đơn vị: cost/đơn-vị × quantity. CARTON: quantity=1/N
        // → mỗi thành phẩm gánh cost-thùng/N. Đặt TRƯỚC check weight===0
        // vì thùng không có khối lượng (weight=0).
        if (comp.inputMode === 'piece' || comp.inputMode === 'carton') {
          return sum + componentCost * quantity;
        }
        // ───────────────────────────────────────────────────────────

        const componentProduct = componentProducts.find(
          (p) => p.id === comp.componentProductId,
        );
        if (!componentProduct) return sum;

        const weight = componentProduct.weight
          ? Number(componentProduct.weight)
          : 0;
        if (weight === 0) return sum;

        const weightInGrams =
          componentProduct.weightUnit === 'kg' ? weight * 1000 : weight;

        return sum + (componentCost / weightInGrams) * quantity;
      }

      return sum + componentCost * quantity;
    }, 0);
  }

  async findAll(query: ProductQueryDto) {
    const {
      page = 1,
      limit,
      search,
      categoryIds,
      isActive,
      branchId,
      branchIds,
      type,
      types,
      parentName,
      middleName,
      childName,
      parentNames,
      middleNames,
      childNames,
      stockStatus,
      tradeMarkId,
      tradeMarkIds,
      isDirectSale,
      priceBookId,
      onlyInPriceBook,
      orderBy,
      orderDirection,
      supplierId,
      factoryId,
      factoryRelation,
      fromCreatedDate,
      toCreatedDate,
    } = query;
    const skip = limit ? (page - 1) * limit : 0;
    const sortDir: 'asc' | 'desc' = orderDirection === 'asc' ? 'asc' : 'desc';

    const where: any = {};
    if (search) {
      const matchedIds = await searchProductIds(this.prisma, search);
      where.id = { in: matchedIds.length > 0 ? matchedIds : [-1] };
    }

    if (priceBookId && priceBookId > 0 && onlyInPriceBook) {
      const pb = await this.prisma.priceBook.findUnique({
        where: { id: priceBookId },
        select: { allowNonListedProducts: true },
      });
      if (pb && !pb.allowNonListedProducts) {
        where.priceBookDetails = {
          some: { priceBookId, isActive: true },
        };
      }
    }

    if (categoryIds) {
      const categoryIdArray = categoryIds
        .split(',')
        .map((id) => parseInt(id.trim()));
      where.categoryId = { in: categoryIdArray };
    }

    if (isActive !== undefined) where.isActive = isActive;

    if (type !== undefined) where.type = type;

    if (types && types.length > 0) where.type = { in: types };

    if (parentNames && parentNames.length > 0)
      where.parentName = { in: parentNames };
    else if (parentName) where.parentName = parentName;

    if (middleNames && middleNames.length > 0)
      where.middleName = { in: middleNames };
    else if (middleName) where.middleName = middleName;

    if (childNames && childNames.length > 0)
      where.childName = { in: childNames };
    else if (childName) where.childName = childName;

    if (tradeMarkIds && tradeMarkIds.length > 0)
      where.tradeMarkId = { in: tradeMarkIds };
    else if (tradeMarkId) where.tradeMarkId = tradeMarkId;
    if (isDirectSale !== undefined) where.isDirectSale = isDirectSale;

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    if (stockStatus === 'instock') {
      where.inventories = { some: { onHand: { gt: 0 } } };
    } else if (stockStatus === 'outstock') {
      where.inventories = { every: { onHand: { lte: 0 } } };
    }

    // ── Filter theo nhà máy (mới) ────────────────────────────────────────────
    // supplierId: filter product mà primary HOẶC backup factory thuộc NCC này.
    // factoryId + factoryRelation: filter product có primary/backup match.
    if (supplierId) {
      where.OR = [
        { primaryFactory: { supplierId } },
        { backupFactory: { supplierId } },
      ];
    } else if (factoryId) {
      if (factoryRelation === 'primary') {
        where.primaryFactoryId = factoryId;
      } else if (factoryRelation === 'backup') {
        where.backupFactoryId = factoryId;
      } else {
        // 'either' hoặc mặc định
        where.OR = [
          { primaryFactoryId: factoryId },
          { backupFactoryId: factoryId },
        ];
      }
    }

    let inventoriesInclude: any = { include: { branch: true } };
    if (branchIds && branchIds.length > 0) {
      inventoriesInclude = {
        where: { branchId: { in: branchIds } },
        include: { branch: true },
      };
    } else if (branchId) {
      inventoriesInclude = {
        where: { branchId },
        include: { branch: true },
      };
    }

    const include = {
      tradeMark: true,
      variant: true,
      images: true,
      documents: true,
      inventories: inventoriesInclude,
      comboComponents: {
        include: {
          componentProduct: {
            include: { images: true, inventories: true },
          },
        },
      },
      primaryFactory: {
        select: {
          id: true,
          code: true,
          name: true,
          country: true,
          currency: true,
        },
      },
      backupFactory: {
        select: {
          id: true,
          code: true,
          name: true,
          country: true,
          currency: true,
        },
      },
    };

    // Cột Inventory cần sắp theo chi nhánh đang chọn. Vì Inventory là quan hệ
    // 1-nhiều, không thể orderBy trực tiếp ổn định qua các trang → sắp xếp ID
    // ở DB trước (raw query lọc theo branch), rồi mới phân trang theo thứ tự đó.
    const INVENTORY_SORT_FIELDS: Record<string, string> = {
      cost: 'cost',
      onHand: 'onHand',
      'inventory.cost': 'cost',
      stock: 'onHand',
      minQuality: 'minQuality',
      maxQuality: 'maxQuality',
      minStock: 'minQuality',
      maxStock: 'maxQuality',
    };

    // Cột trực tiếp trên Product.
    const PRODUCT_SORT_FIELDS: Record<string, string> = {
      basePrice: 'basePrice',
    };

    if (orderBy && INVENTORY_SORT_FIELDS[orderBy]) {
      const invField = INVENTORY_SORT_FIELDS[orderBy];

      // Lấy TẤT CẢ product id thỏa `where` (đã gồm mọi filter: search, isActive,
      // type, category, parent/middle/child, tradeMark, stockStatus...). Sau đó
      // sắp xếp các id này theo giá trị tồn kho của chi nhánh đang chọn ở DB,
      // rồi mới phân trang → thứ tự đúng & xuyên suốt qua các trang.
      const allMatched = await this.prisma.product.findMany({
        where,
        select: { id: true },
      });
      const total = allMatched.length;
      const matchedIds = allMatched.map((p) => p.id);

      let orderedIds: number[] = [];
      if (matchedIds.length > 0) {
        const branchParam =
          branchId != null
            ? branchId
            : branchIds && branchIds.length === 1
              ? branchIds[0]
              : null;

        const orderedRows = await this.prisma.$queryRawUnsafe<{ id: number }[]>(
          this.buildInventorySortSql(invField, sortDir),
          matchedIds,
          branchParam,
        );
        orderedIds = orderedRows.map((r) => r.id);
      }

      const pageIds = orderedIds.slice(skip, limit ? skip + limit : undefined);

      const pageProducts = await this.prisma.product.findMany({
        where: { id: { in: pageIds } },
        include,
      });

      // Giữ đúng thứ tự đã sắp xếp (findMany không đảm bảo thứ tự theo in[]).
      const byId = new Map(pageProducts.map((p) => [p.id, p]));
      const data = pageIds.map((id) => byId.get(id)).filter(Boolean);

      return { data, total, page, limit };
    }

    const productOrderBy =
      orderBy && PRODUCT_SORT_FIELDS[orderBy]
        ? { [PRODUCT_SORT_FIELDS[orderBy]]: sortDir }
        : { createdAt: 'desc' as const };

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        ...(limit ? { take: limit } : {}),
        include,
        orderBy: productOrderBy,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Sinh câu SQL sắp xếp product id theo trường tồn kho của chi nhánh.
   * Dùng LEFT JOIN + COALESCE(...,0) để sản phẩm chưa có inventory không bị loại.
   * Khi không lọc theo chi nhánh cụ thể → cộng dồn (SUM) toàn bộ chi nhánh.
   */
  private buildInventorySortSql(
    invField: 'cost' | 'onHand' | 'minQuality' | 'maxQuality' | string,
    sortDir: 'asc' | 'desc',
  ): string {
    // invField đã được map từ whitelist nội bộ → an toàn để nội suy tên cột.
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    return `
      SELECT p.id AS id
      FROM products p
      LEFT JOIN inventories inv
        ON inv."productId" = p.id
        AND ($BRANCH_FILTER$)
      WHERE p.id = ANY($1::int[])
      GROUP BY p.id, p."createdAt"
      ORDER BY COALESCE(SUM(inv."${invField}"), 0) ${dir}, p."createdAt" DESC
    `.replace('$BRANCH_FILTER$', this.inventoryBranchFilterClause());
  }

  private inventoryBranchFilterClause(): string {
    // $2 = branchId (nullable). Khi NULL → lấy tất cả chi nhánh.
    return `($2::int IS NULL OR inv."branchId" = $2::int)`;
  }

  private getProductTypeLabel(type: number): string {
    switch (type) {
      case 1:
        return 'Combo - đóng gói';
      case 2:
        return 'Hàng hóa';
      case 3:
        return 'Dịch vụ';
      case 4:
        return 'Hàng sản xuất';
      default:
        return 'Hàng hóa';
    }
  }

  /** Nhóm hàng 3 cấp: parentName>>middleName>>childName (bỏ cấp rỗng). */
  private buildCategoryPath(p: {
    parentName?: string | null;
    middleName?: string | null;
    childName?: string | null;
  }): string {
    return [p.parentName, p.middleName, p.childName]
      .filter((s) => s && String(s).trim())
      .join('>>');
  }

  /** Giá vốn combo = tổng (giá vốn linh kiện tại chi nhánh * số lượng). */
  private calcComboCost(product: any, branchId?: number): number {
    if (!product.comboComponents) return 0;
    return product.comboComponents.reduce((sum: number, comp: any) => {
      const cp = comp.componentProduct;
      if (!cp) return sum;
      const inv = branchId
        ? cp.inventories?.find((i: any) => i.branchId === branchId)
        : cp.inventories?.[0];
      const cost = inv ? Number(inv.cost) : 0;
      return sum + cost * Number(comp.quantity || 0);
    }, 0);
  }

  /**
   * Xuất danh sách sản phẩm ra Excel (stream theo batch).
   * - Lọc giống findAll (search, category, parent/middle/child, stockStatus, isActive, type).
   * - Tồn kho / giá vốn / tồn min-max lấy theo chi nhánh đang chọn (branchId).
   * - `query.columns` (CSV) quyết định cột nào được xuất; luôn có type/code/name.
   */
  async exportProducts(query: ProductQueryDto, res: Response): Promise<void> {
    const {
      search,
      categoryIds,
      isActive,
      branchId,
      type,
      types,
      parentName,
      middleName,
      childName,
      parentNames,
      middleNames,
      childNames,
      stockStatus,
      tradeMarkId,
      tradeMarkIds,
      isDirectSale,
      priceBookId,
      onlyInPriceBook,
      columns,
      fromCreatedDate,
      toCreatedDate,
      asOfDate,
    } = query;

    // ── Build where (mirror findAll) ─────────────────────────────────────────
    const where: any = {};
    if (search) {
      const matchedIds = await searchProductIds(this.prisma, search);
      where.id = { in: matchedIds.length > 0 ? matchedIds : [-1] };
    }

    if (priceBookId && priceBookId > 0 && onlyInPriceBook) {
      const pb = await this.prisma.priceBook.findUnique({
        where: { id: priceBookId },
        select: { allowNonListedProducts: true },
      });
      if (pb && !pb.allowNonListedProducts) {
        where.priceBookDetails = { some: { priceBookId, isActive: true } };
      }
    }

    if (categoryIds) {
      const categoryIdArray = categoryIds
        .split(',')
        .map((id) => parseInt(id.trim()));
      where.categoryId = { in: categoryIdArray };
    }

    if (isActive !== undefined) where.isActive = isActive;
    if (type !== undefined) where.type = type;
    if (types && types.length > 0) where.type = { in: types };
    if (parentNames && parentNames.length > 0)
      where.parentName = { in: parentNames };
    else if (parentName) where.parentName = parentName;

    if (middleNames && middleNames.length > 0)
      where.middleName = { in: middleNames };
    else if (middleName) where.middleName = middleName;

    if (childNames && childNames.length > 0)
      where.childName = { in: childNames };
    else if (childName) where.childName = childName;

    if (tradeMarkIds && tradeMarkIds.length > 0)
      where.tradeMarkId = { in: tradeMarkIds };
    else if (tradeMarkId) where.tradeMarkId = tradeMarkId;
    if (isDirectSale !== undefined) where.isDirectSale = isDirectSale;

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    if (stockStatus === 'instock') {
      where.inventories = { some: { onHand: { gt: 0 } } };
    } else if (stockStatus === 'outstock') {
      where.inventories = { every: { onHand: { lte: 0 } } };
    }

    let inventoriesInclude: any = { include: { branch: true } };
    if (branchId) {
      inventoriesInclude = { where: { branchId }, include: { branch: true } };
    }

    // ── Cột cần xuất ───────────────────────────────────────────────────────
    const ALL_COLUMNS: Record<
      string,
      { header: string; width: number; value: (p: any, ctx: any) => any }
    > = {
      type: {
        header: 'Loại hàng',
        width: 16,
        value: (p) => this.getProductTypeLabel(p.type),
      },
      categoryPath: {
        header: 'Nhóm hàng(3 Cấp)',
        width: 30,
        value: (p) => this.buildCategoryPath(p),
      },
      code: { header: 'Mã hàng', width: 16, value: (p) => p.code ?? '' },
      name: { header: 'Tên hàng', width: 40, value: (p) => p.name ?? '' },
      tradeMark: {
        header: 'Thương hiệu',
        width: 20,
        value: (p) => p.tradeMark?.name ?? '',
      },
      basePrice: {
        header: 'Giá bán',
        width: 14,
        value: (p) => Number(p.basePrice ?? 0),
      },
      cost: {
        header: 'Giá vốn',
        width: 14,
        value: (p, ctx) => {
          if (p.type === 1) return this.calcComboCost(p, ctx.branchId);
          const inv = ctx.branchId
            ? p.inventories?.find((i: any) => i.branchId === ctx.branchId)
            : p.inventories?.[0];
          return inv ? Number(inv.cost) : 0;
        },
      },
      stock: {
        header: 'Tồn kho',
        width: 12,
        value: (p, ctx) => {
          // Tồn kho tại thời điểm (asOfDate) — chỉ dùng khi ctx cung cấp map
          // (yêu cầu branchId). Khi có, ưu tiên tuyệt đối để file phản ánh tồn
          // tại ngày đã chọn thay vì onHand hiện tại.
          const stockAtDateMap = ctx?.stockAtDateMap as
            | Record<number, number>
            | undefined;
          if (stockAtDateMap) {
            return stockAtDateMap[p.id] ?? 0;
          }
          if (ctx.branchId) {
            const inv = p.inventories?.find(
              (i: any) => i.branchId === ctx.branchId,
            );
            return inv ? Number(inv.onHand) : 0;
          }
          return (
            p.inventories?.reduce(
              (s: number, i: any) => s + Number(i.onHand),
              0,
            ) || 0
          );
        },
      },
      customerOrder: {
        header: 'Khách đặt',
        width: 12,
        value: (p, ctx) => ctx.pendingMap?.[p.id] ?? 0,
      },
      supplierOrder: {
        header: 'Đặt NCC',
        width: 12,
        value: (p, ctx) => ctx.supplierMap?.[p.id] ?? 0,
      },
      minStock: {
        header: 'Tồn nhỏ nhất',
        width: 14,
        value: (p, ctx) => {
          const inv = ctx.branchId
            ? p.inventories?.find((i: any) => i.branchId === ctx.branchId)
            : p.inventories?.[0];
          return inv ? Number(inv.minQuality) : 0;
        },
      },
      maxStock: {
        header: 'Tồn lớn nhất',
        width: 14,
        value: (p, ctx) => {
          const inv = ctx.branchId
            ? p.inventories?.find((i: any) => i.branchId === ctx.branchId)
            : p.inventories?.[0];
          return inv ? Number(inv.maxQuality) : 0;
        },
      },
      unit: { header: 'ĐVT', width: 10, value: (p) => p.unit ?? '' },
      images: {
        header: 'Hình ảnh (url1,url2...)',
        width: 30,
        value: (p) =>
          (p.images || []).map((img: any) => img.image).join(',') || '',
      },
      weight: {
        header: 'Trọng lượng',
        width: 14,
        value: (p) => (p.weight != null ? Number(p.weight) : ''),
      },
      shippingWeight: {
        header: 'Trọng lượng vận chuyển',
        width: 20,
        value: (p) =>
          p.shippingWeight != null ? Number(p.shippingWeight) : '',
      },
      vat: {
        header: 'VAT (%)',
        width: 10,
        value: (p) => (p.vat != null ? Number(p.vat) : 8),
      },
      isDirectSale: {
        header: 'Được bán trực tiếp',
        width: 18,
        value: (p) => (p.isDirectSale ? 1 : 0),
      },
      isActive: {
        header: 'Đang kinh doanh',
        width: 16,
        value: (p) => (p.isActive ? 1 : 0),
      },
      description: {
        header: 'Mô tả',
        width: 30,
        value: (p) => p.description ?? '',
      },
      components: {
        header: 'Hàng thành phần',
        width: 30,
        value: (p) =>
          (p.comboComponents || [])
            .map(
              (c: any) =>
                `${c.componentProduct?.code ?? ''}:${Number(c.quantity || 0)}`,
            )
            .join(','),
      },
      createdAt: {
        header: 'Thời gian tạo',
        width: 20,
        value: (p) =>
          p.createdAt ? new Date(p.createdAt).toLocaleString('vi-VN') : '',
      },
    };

    // Cột mặc định bắt buộc + thứ tự ưu tiên cố định để file luôn nhất quán.
    const COLUMN_ORDER = [
      'type',
      'categoryPath',
      'code',
      'name',
      'tradeMark',
      'basePrice',
      'cost',
      'stock',
      'customerOrder',
      'supplierOrder',
      'minStock',
      'maxStock',
      'unit',
      'images',
      'weight',
      'shippingWeight',
      'vat',
      'isDirectSale',
      'isActive',
      'description',
      'components',
      'createdAt',
    ];
    const REQUIRED = ['type', 'code', 'name'];

    const requested = new Set(
      (columns || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && ALL_COLUMNS[s]),
    );
    // Luôn đảm bảo cột bắt buộc có mặt.
    REQUIRED.forEach((k) => requested.add(k));

    const selectedKeys = COLUMN_ORDER.filter((k) => requested.has(k));

    const needPending = selectedKeys.includes('customerOrder');
    const needSupplier = selectedKeys.includes('supplierOrder');

    // Tồn kho tại thời điểm (asOfDate): chỉ kích hoạt khi có cả asOfDate và
    // branchId (previewStockAtDate yêu cầu branchId). Khi không đủ điều kiện,
    // bỏ qua → cột stock dùng onHand hiện tại như cũ.
    const needStockAtDate =
      selectedKeys.includes('stock') && !!asOfDate && !!branchId;

    // ── Stream Excel ─────────────────────────────────────────────────────────
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Sản phẩm');

    sheet.columns = selectedKeys.map((k) => ({
      header: ALL_COLUMNS[k].header,
      key: k,
      width: ALL_COLUMNS[k].width,
    }));

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
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.product.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          tradeMark: true,
          images: true,
          inventories: inventoriesInclude,
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true, inventories: true },
              },
            },
          },
        },
      });

      if (batch.length === 0) break;

      const ids = batch.map((p) => p.id);
      const pendingMap = needPending
        ? await this.ordersService.getPendingSummary(ids, branchId)
        : {};
      const supplierMap = needSupplier
        ? await this.orderSuppliersService.getConfirmedSummary(ids, branchId)
        : {};
      // Map tồn kho tại thời điểm asOfDate (theo branchId). Dùng đúng nguồn
      // chân lý previewStockAtDate (getActiveLogKeys + isLogActive), khớp thẻ
      // kho. Bỏ qua khi needStockAtDate = false → ctx không có stockAtDateMap
      // → cột stock dùng onHand hiện tại.
      const stockAtDateMap = needStockAtDate
        ? await this.stockAuditsService.previewStockAtDate(
            branchId,
            ids,
            asOfDate,
          )
        : undefined;

      const ctx = { branchId, pendingMap, supplierMap, stockAtDateMap };

      for (const p of batch) {
        const rowData: Record<string, any> = {};
        for (const k of selectedKeys) {
          rowData[k] = ALL_COLUMNS[k].value(p, ctx);
        }
        const row = sheet.addRow(rowData);
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        variant: true,
        tradeMark: true,
        images: true,
        documents: true,
        inventories: {
          include: { branch: true },
        },
        comboComponents: {
          include: {
            componentProduct: {
              include: {
                images: true,
                inventories: true,
              },
            },
          },
        },
        primaryFactory: true,
        backupFactory: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    return product;
  }

  async checkCodeExists(code: string, excludeId?: number): Promise<boolean> {
    const existing = await this.prisma.product.findUnique({
      where: { code },
    });

    if (!existing) return false;
    if (excludeId && existing.id === excludeId) return false;

    return true;
  }

  async create(dto: CreateProductDto, userId?: number) {
    const {
      imageUrls,
      documents,
      publicationLocation,
      publicationDate,
      publicationLink,
      components,
      initialInventory,
      branchId,
      costScope,
      costBranchIds,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      parentName,
      middleName,
      childName,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      manualCostOverride,
      primaryFactoryId,
      backupFactoryId,
      ...productData
    } = dto;

    // Validate factory: nếu cả 2 đều có thì không được trùng nhau
    if (
      primaryFactoryId != null &&
      backupFactoryId != null &&
      primaryFactoryId === backupFactoryId
    ) {
      throw new BadRequestException(
        'Nhà máy chính và nhà máy backup không được trùng nhau',
      );
    }

    // Validate factory tồn tại
    const factoryIdsToCheck = [primaryFactoryId, backupFactoryId].filter(
      (id) => id != null,
    );
    if (factoryIdsToCheck.length > 0) {
      const foundFactories = await this.prisma.factory.findMany({
        where: { id: { in: factoryIdsToCheck } },
        select: { id: true },
      });
      const foundIds = new Set(foundFactories.map((f) => f.id));
      const missing = factoryIdsToCheck.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Nhà máy không tồn tại: ${missing.join(', ')}`,
        );
      }
    }

    // Phòng vệ NaN (xem update()): loại số không hợp lệ trước khi đưa vào Prisma.
    const sanitizeNumber = (v: any): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const safePurchasePrice = sanitizeNumber(purchasePrice);
    const safeBasePrice = sanitizeNumber(basePrice);
    const safeStockQuantity = sanitizeNumber(stockQuantity);
    const safeMinStockAlert = sanitizeNumber(minStockAlert);
    const safeMaxStockAlert = sanitizeNumber(maxStockAlert);
    for (const key of [
      'weight',
      'vat',
      'shippingWeight',
      'conversionValue',
    ] as const) {
      if (
        key in productData &&
        sanitizeNumber((productData as any)[key]) === undefined
      ) {
        delete (productData as any)[key];
      }
    }

    const name = dto.name;
    const attributesText = dto.attributesText || null;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    return this.prisma.$transaction(async (tx) => {
      const productCode =
        productData.code || (await this.generateSafeProductCode(tx));

      const product = await tx.product.create({
        data: {
          code: productCode,
          name: productData.name,
          fullName,
          description: productData.description,
          orderTemplate: productData.orderTemplate,
          parentName: parentName || null,
          middleName: middleName || null,
          childName: childName || null,
          type: productData.type || 2,
          allowsSale: productData.allowsSale,
          hasVariants: productData.hasVariants,
          basePrice: safeBasePrice ?? 0,
          unit: productData.unit,
          conversionValue: productData.conversionValue,
          weight: productData.weight,
          weightUnit: productData.weightUnit,
          vat: productData.vat ?? 8,
          shippingWeight: productData.shippingWeight,
          shippingWeightUnit: productData.shippingWeightUnit ?? 'g',
          attributesText,
          isRewardPoint: productData.isRewardPoint,
          isActive: productData.isActive ?? true,
          isDirectSale: productData.isDirectSale ?? false,
          isPieceUnit: productData.isPieceUnit ?? false,
          publicationLocation: publicationLocation
            ? (publicationLocation as any)
            : undefined,
          publicationDate: publicationDate
            ? new Date(publicationDate)
            : undefined,
          publicationLink: publicationLink ?? undefined,
          masterUnitId: masterUnitId,
          ...(masterUnitId && { masterUnitId }),
          ...(tradeMarkId && {
            tradeMark: { connect: { id: tradeMarkId } },
          }),
          ...(variantId && {
            variant: { connect: { id: variantId } },
          }),
          ...(masterProductId && {
            masterProduct: { connect: { id: masterProductId } },
          }),
          ...(primaryFactoryId != null && {
            primaryFactory: { connect: { id: primaryFactoryId } },
          }),
          ...(backupFactoryId != null && {
            backupFactory: { connect: { id: backupFactoryId } },
          }),
        },
      });

      // Ghi audit log cho lần gắn nhà máy đầu tiên (nếu có)
      if (factoryIdsToCheck.length > 0 && userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        const logs: Array<{
          productId: number;
          factoryId: number;
          role: string;
          previousFactoryId: number | null;
          changedById: number;
          changedByName: string | null;
          reason: string;
        }> = [];
        if (primaryFactoryId != null) {
          logs.push({
            productId: product.id,
            factoryId: primaryFactoryId,
            role: 'primary',
            previousFactoryId: null,
            changedById: userId,
            changedByName: user?.name ?? null,
            reason: 'set_primary',
          });
        }
        if (backupFactoryId != null) {
          logs.push({
            productId: product.id,
            factoryId: backupFactoryId,
            role: 'backup',
            previousFactoryId: null,
            changedById: userId,
            changedByName: user?.name ?? null,
            reason: 'set_backup',
          });
        }
        if (logs.length > 0) {
          await tx.factoryChangeLog.createMany({ data: logs });
        }
      }

      if (imageUrls && imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url) => ({
            productId: product.id,
            image: url,
          })),
        });
      }

      if (documents && documents.length > 0) {
        await tx.productDocument.createMany({
          data: documents.map((doc) => ({
            productId: product.id,
            url: doc.url,
            originalName: doc.originalName ?? null,
            mimetype: doc.mimetype ?? null,
            size: doc.size ?? null,
          })),
        });
      }

      const allBranches = await tx.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      const cost = safePurchasePrice ?? 0;
      const onHand = safeStockQuantity ?? 0;
      const minQuality = safeMinStockAlert ?? 0;
      const maxQuality = safeMaxStockAlert ?? 0;

      let branchesToCreateInventory: { id: number; name: string }[] = [];

      if (costScope === 'all') {
        branchesToCreateInventory = allBranches;
      } else if (
        costScope === 'specific' &&
        costBranchIds &&
        costBranchIds.length > 0
      ) {
        branchesToCreateInventory = allBranches.filter((b) =>
          costBranchIds.includes(b.id),
        );
      } else {
        if (branchId) {
          const currentBranch = allBranches.find((b) => b.id === branchId);
          if (currentBranch) {
            branchesToCreateInventory = [currentBranch];
          }
        }
      }

      const inventoryData = await Promise.all(
        branchesToCreateInventory.map(async (branch) => {
          const isCurrentBranch =
            branchId !== undefined && branch.id === branchId;

          let branchCost = cost;
          if (
            !dto.manualCostOverride &&
            (dto.type === 1 || dto.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branch.id,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              dto.type,
            );
          }

          const branchOnHand = isCurrentBranch ? onHand : 0;
          const totalWeight = this.calculateTotalWeight(
            dto.weight,
            dto.weightUnit,
            branchOnHand,
          );

          return {
            productId: product.id,
            productCode: product.code,
            productName: product.name,
            branchId: branch.id,
            branchName: branch.name,
            cost: branchCost,
            onHand: branchOnHand,
            reserved: 0,
            onOrder: 0,
            minQuality: isCurrentBranch ? minQuality : 0,
            maxQuality: isCurrentBranch ? maxQuality : 0,
            totalWeight: totalWeight,
          };
        }),
      );

      console.log(
        '[DEBUG CREATE] branchesToCreateInventory:',
        branchesToCreateInventory.map((b) => ({ id: b.id, name: b.name })),
      );
      console.log('[DEBUG CREATE] inventoryData.length:', inventoryData.length);

      if (inventoryData.length > 0) {
        await tx.inventory.createMany({ data: inventoryData });
      }

      if (
        !dto.manualCostOverride &&
        (dto.type === 1 || dto.type === 4) &&
        components &&
        components.length > 0
      ) {
        await tx.productComponent.createMany({
          data: components.map((comp) => ({
            comboProductId: product.id,
            componentProductId: comp.componentProductId,
            quantity: comp.quantity,
            inputMode: comp.inputMode ?? 'gram',
          })),
        });
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const finalProduct = await tx.product.findUnique({
          where: { id: product.id },
          include: { variant: true, tradeMark: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'PRODUCT_CREATE',
          entityType: 'products',
          entityId: product.id.toString(),
          entityCode: product.code,
          category: getCategoryFromActionCode('PRODUCT_CREATE'),
          severity: getSeverityFromActionCode('PRODUCT_CREATE'),
          snapshot: this.buildProductSnapshot(finalProduct || product),
          message: renderAuditMessage('PRODUCT_CREATE', {
            productName: product.name,
            productCode: product.code,
            basePrice: Number(product.basePrice || 0),
          }),
          messageTemplate: 'PRODUCT_CREATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: user?.branchId || undefined,
        });
      }

      this.larkProductSync.enqueueSync(product.id);

      return tx.product.findUnique({
        where: { id: product.id },
        include: {
          variant: true,
          tradeMark: true,
          images: true,
          documents: true,
          inventories: {
            include: { branch: true },
          },
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true },
              },
            },
          },
        },
      });
    });
  }

  async update(id: number, dto: UpdateProductDto, userId?: number) {
    const currentProduct = await this.prisma.product.findUnique({
      where: { id },
      include: {
        images: true,
        documents: true,
        comboComponents: true,
        inventories: true,
        variant: true,
        tradeMark: true,
      },
    });

    if (!currentProduct) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    const name = dto.name || currentProduct.name;
    const attributesText =
      dto.attributesText !== undefined
        ? dto.attributesText
        : currentProduct.attributesText;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    const {
      imageUrls,
      documents,
      publicationLocation,
      publicationDate,
      publicationLink,
      components,
      initialInventory,
      branchId,
      costScope,
      costBranchIds,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      parentName,
      middleName,
      childName,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      manualCostOverride,
      primaryFactoryId,
      backupFactoryId,
      ...productData
    } = dto;

    // Validate factory: nếu cả 2 đều có thì không được trùng nhau
    if (
      primaryFactoryId != null &&
      backupFactoryId != null &&
      primaryFactoryId === backupFactoryId
    ) {
      throw new BadRequestException(
        'Nhà máy chính và nhà máy backup không được trùng nhau',
      );
    }

    // Validate factory tồn tại nếu được truyền (không null)
    const factoryIdsToCheck = [primaryFactoryId, backupFactoryId].filter(
      (id) => id != null,
    );
    if (factoryIdsToCheck.length > 0) {
      const foundFactories = await this.prisma.factory.findMany({
        where: { id: { in: factoryIdsToCheck } },
        select: { id: true },
      });
      const foundIds = new Set(foundFactories.map((f) => f.id));
      const missing = factoryIdsToCheck.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `Nhà máy không tồn tại: ${missing.join(', ')}`,
        );
      }
    }

    // Detect thay đổi primary/backup factory để ghi audit log sau
    const factoryChanges: Array<{
      role: 'primary' | 'backup';
      factoryId: number;
      previousFactoryId: number | null;
      reason: string;
    }> = [];

    if (primaryFactoryId !== undefined) {
      const newId = primaryFactoryId ?? null;
      const oldId = currentProduct.primaryFactoryId ?? null;
      if (newId !== oldId) {
        factoryChanges.push({
          role: 'primary',
          factoryId: newId ?? 0,
          previousFactoryId: oldId,
          reason:
            newId === null
              ? 'unlink'
              : oldId === backupFactoryId && oldId != null
                ? 'swap'
                : 'set_primary',
        });
        (productData as any).primaryFactoryId = newId;
      }
    }
    if (backupFactoryId !== undefined) {
      const newId = backupFactoryId ?? null;
      const oldId = currentProduct.backupFactoryId ?? null;
      if (newId !== oldId) {
        factoryChanges.push({
          role: 'backup',
          factoryId: newId ?? 0,
          previousFactoryId: oldId,
          reason:
            newId === null
              ? 'unlink'
              : oldId === primaryFactoryId && oldId != null
                ? 'swap'
                : 'set_backup',
        });
        (productData as any).backupFactoryId = newId;
      }
    }

    // Phòng vệ NaN: client có thể gửi NaN khi giá trị số được derive từ dữ liệu
    // đã bị strip (vd giá vốn bị ẩn theo quyền → Number(undefined) = NaN). Prisma
    // không nhận NaN cho cột Decimal → ném PrismaClientValidationError ("Dữ liệu
    // không hợp lệ"). Loại bỏ mọi số không hợp lệ trước khi đưa vào Prisma.
    const sanitizeNumber = (v: any): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;

    const safePurchasePrice = sanitizeNumber(purchasePrice);
    const safeBasePrice = sanitizeNumber(basePrice);
    const safeStockQuantity = sanitizeNumber(stockQuantity);
    const safeMinStockAlert = sanitizeNumber(minStockAlert);
    const safeMaxStockAlert = sanitizeNumber(maxStockAlert);

    // Làm sạch các field số nằm trong productData (đổ thẳng vào product.update).
    for (const key of [
      'weight',
      'vat',
      'shippingWeight',
      'conversionValue',
    ] as const) {
      if (
        key in productData &&
        sanitizeNumber((productData as any)[key]) === undefined
      ) {
        delete (productData as any)[key];
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          ...productData,
          fullName,
          basePrice:
            safeBasePrice !== undefined
              ? safeBasePrice
              : currentProduct.basePrice,
          ...(masterUnitId !== undefined && { masterUnitId }),
          ...(publicationLocation !== undefined && {
            publicationLocation: publicationLocation as any,
          }),
          ...(publicationDate !== undefined && {
            publicationDate: publicationDate ? new Date(publicationDate) : null,
          }),
          ...(publicationLink !== undefined && {
            publicationLink: publicationLink || null,
          }),
          ...(parentName !== undefined && { parentName: parentName || null }),
          ...(middleName !== undefined && { middleName: middleName || null }),
          ...(childName !== undefined && { childName: childName || null }),
          isPieceUnit: dto.isPieceUnit ?? undefined,
          ...(tradeMarkId !== undefined && {
            tradeMark: tradeMarkId
              ? { connect: { id: tradeMarkId } }
              : { disconnect: true },
          }),
          ...(variantId !== undefined && {
            variant: variantId
              ? { connect: { id: variantId } }
              : { disconnect: true },
          }),
          ...(masterProductId !== undefined && {
            masterProduct: masterProductId
              ? { connect: { id: masterProductId } }
              : { disconnect: true },
          }),
        },
      });

      // Ghi audit log nếu có thay đổi primary/backup factory
      if (factoryChanges.length > 0 && userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        await tx.factoryChangeLog.createMany({
          data: factoryChanges.map((change) => ({
            productId: id,
            factoryId: change.factoryId,
            role: change.role,
            previousFactoryId: change.previousFactoryId,
            changedById: userId,
            changedByName: user?.name ?? null,
            reason: change.reason,
          })),
        });
      }

      if (dto.code || dto.name) {
        const newCode = dto.code || currentProduct.code;
        const newName = dto.name || currentProduct.name;
        await this.syncProductInfoToInventories(id, newCode, newName, tx);
      }

      if (dto.weight !== undefined || dto.weightUnit !== undefined) {
        const newWeight =
          dto.weight !== undefined ? dto.weight : currentProduct.weight;
        const newWeightUnit =
          dto.weightUnit !== undefined
            ? dto.weightUnit
            : currentProduct.weightUnit;
        await this.syncTotalWeightToInventories(
          id,
          newWeight,
          newWeightUnit,
          tx,
        );
      }

      if (imageUrls !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        if (imageUrls.length > 0) {
          await tx.productImage.createMany({
            data: imageUrls.map((url) => ({
              productId: id,
              image: url,
            })),
          });
        }
      }

      if (documents !== undefined) {
        await tx.productDocument.deleteMany({ where: { productId: id } });
        if (documents.length > 0) {
          await tx.productDocument.createMany({
            data: documents.map((doc) => ({
              productId: id,
              url: doc.url,
              originalName: doc.originalName ?? null,
              mimetype: doc.mimetype ?? null,
              size: doc.size ?? null,
            })),
          });
        }
      }

      const cost = safePurchasePrice;
      const onHand = safeStockQuantity;
      const minQuality = safeMinStockAlert;
      const maxQuality = safeMaxStockAlert;

      // Đọc giá trị onHand cũ để so sánh sau khi upsert
      let oldOnHand: number | null = null;
      if (onHand !== undefined && branchId) {
        const existingInventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: id,
              branchId: branchId,
            },
          },
          select: { onHand: true, cost: true },
        });
        oldOnHand = existingInventory ? Number(existingInventory.onHand) : 0;
      }

      if (
        cost !== undefined &&
        (costScope === 'all' || costScope === 'specific')
      ) {
        const allBranches = await tx.branch.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
        });

        let branchesToUpdateCost: { id: number; name: string }[] = [];

        if (costScope === 'all') {
          branchesToUpdateCost = allBranches;
        } else if (
          costScope === 'specific' &&
          costBranchIds &&
          costBranchIds.length > 0
        ) {
          branchesToUpdateCost = allBranches.filter((b) =>
            costBranchIds.includes(b.id),
          );
        }

        for (const branch of branchesToUpdateCost) {
          const isCurrentBranch = branch.id === branchId;

          let branchCost = cost;

          if (
            !dto.manualCostOverride &&
            (currentProduct.type === 1 || currentProduct.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branch.id,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              currentProduct.type,
            );
          }

          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: id,
                branchId: branch.id,
              },
            },
            create: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branch.id,
              branchName: branch.name,
              cost: branchCost,
              onHand: isCurrentBranch && onHand !== undefined ? onHand : 0,
              reserved: 0,
              onOrder: 0,
              minQuality:
                isCurrentBranch && minQuality !== undefined ? minQuality : 0,
              maxQuality:
                isCurrentBranch && maxQuality !== undefined ? maxQuality : 0,
              totalWeight: this.calculateTotalWeight(
                product.weight,
                product.weightUnit,
                isCurrentBranch && onHand !== undefined ? onHand : 0,
              ),
            },
            update: {
              cost: branchCost,
              productCode: product.code,
              productName: product.name,
              ...(isCurrentBranch &&
                onHand !== undefined && {
                  onHand,
                  totalWeight: this.calculateTotalWeight(
                    product.weight,
                    product.weightUnit,
                    onHand,
                  ),
                }),
              ...(isCurrentBranch &&
                minQuality !== undefined && { minQuality }),
              ...(isCurrentBranch &&
                maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      } else if (cost !== undefined) {
        if (branchId) {
          const branch = await tx.branch.findUnique({
            where: { id: branchId },
            select: { name: true },
          });

          let branchCost = cost;

          if (
            !dto.manualCostOverride &&
            (currentProduct.type === 1 || currentProduct.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branchId,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              currentProduct.type,
            );
          }

          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: id,
                branchId: branchId,
              },
            },
            create: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branchId,
              branchName: branch?.name || '',
              cost: branchCost,
              onHand: onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: minQuality || 0,
              maxQuality: maxQuality || 0,
              totalWeight: this.calculateTotalWeight(
                product.weight,
                product.weightUnit,
                onHand || 0,
              ),
            },
            update: {
              cost: branchCost,
              productCode: product.code,
              productName: product.name,
              ...(onHand !== undefined && {
                onHand,
                totalWeight: this.calculateTotalWeight(
                  product.weight,
                  product.weightUnit,
                  onHand,
                ),
              }),
              ...(minQuality !== undefined && { minQuality }),
              ...(maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      }

      // Tạo StockAudit + InventoryLog nếu tồn kho thay đổi
      if (onHand !== undefined && branchId && oldOnHand !== null) {
        // LOG-BASED (NGUỒN CHÂN LÝ): tồn "hệ thống" để so sánh = Σ log ACTIVE
        // trên thẻ kho (loại chứng từ đã hủy + tồn ảo không có log). delta =
        // số người dùng nhập − tồn-thẻ-kho-hiện-tại.
        const sumLogs = await computeOnHandFromLogs(tx, id, branchId);
        const delta = Number(onHand) - sumLogs;
        if (delta !== 0) {
          // Sinh mã KK tiếp theo (chung sequence với StockAudit)
          const lastAudit = await tx.stockAudit.findFirst({
            orderBy: { id: 'desc' },
            select: { code: true },
          });
          const nextNum = lastAudit
            ? parseInt(lastAudit.code.replace('KK', ''), 10) + 1
            : 1;
          const auditCode = `KK${String(nextNum).padStart(6, '0')}`;

          // Lấy thông tin branch
          const auditBranch = await tx.branch.findUnique({
            where: { id: branchId },
            select: { name: true },
          });

          // Lấy thông tin user
          let auditUserName = 'System';
          if (userId) {
            const auditUser = await tx.user.findUnique({
              where: { id: userId },
              select: { name: true, email: true },
            });
            auditUserName = auditUser?.name || auditUser?.email || 'System';
          }

          // Lấy cost hiện tại
          const currentInventory = await tx.inventory.findUnique({
            where: {
              productId_branchId: { productId: id, branchId },
            },
            select: { cost: true },
          });
          const currentCost = Number(currentInventory?.cost || 0);

          // Tạo StockAudit (status = 2: COMPLETED)
          const stockAudit = await tx.stockAudit.create({
            data: {
              code: auditCode,
              branchId: branchId,
              branchName: auditBranch?.name || '',
              checkDate: new Date(),
              note: `Điều chỉnh tồn kho từ trang sản phẩm: ${product.name}`,
              status: 2,
              createdById: userId || 1,
              createdByName: auditUserName,
              completedById: userId || 1,
              completedByName: auditUserName,
              completedAt: new Date(),
              details: {
                create: {
                  productId: id,
                  productCode: product.code,
                  productName: product.name,
                  unit: currentProduct.unit,
                  systemQuantity: sumLogs,
                  actualQuantity: Number(onHand),
                  difference: delta,
                  costAtCheck: currentCost,
                  differenceValue: delta * currentCost,
                },
              },
            },
          });

          // Tạo InventoryLog (transactionDate = now → nằm cuối thẻ kho)
          await tx.inventoryLog.create({
            data: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branchId,
              branchName: auditBranch?.name || '',
              transactionType: 'STOCK_AUDIT',
              refCode: auditCode,
              refType: 'stock_audit',
              refId: stockAudit.id,
              quantity: delta,
              costPrice: currentCost,
              transactionDate: new Date(),
              note: `Điều chỉnh tồn kho từ trang sản phẩm: ${product.name} (${sumLogs} → ${onHand})`,
              userId: userId ?? undefined,
              createdByName: auditUserName,
            },
          });

          // RE-ANCHOR: tính lại chuỗi phiếu kiểm + onHand theo timeline.
          await recalcStockAuditChain(tx, id, branchId);
        }
      }

      if (components !== undefined) {
        await tx.productComponent.deleteMany({
          where: { comboProductId: id },
        });

        if (components.length > 0) {
          await tx.productComponent.createMany({
            data: components.map((comp) => ({
              comboProductId: id,
              componentProductId: comp.componentProductId,
              quantity: comp.quantity,
              inputMode: comp.inputMode ?? 'gram',
            })),
          });
        }
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const updatedProduct = await tx.product.findUnique({
          where: { id },
          include: { variant: true, tradeMark: true },
        });

        const changes = buildChanges(
          'products',
          {
            name: currentProduct.name,
            basePrice: Number(currentProduct.basePrice || 0),
            weight: Number(currentProduct.weight || 0),
            weightUnit: currentProduct.weightUnit,
            unit: currentProduct.unit,
            isActive: currentProduct.isActive,
            allowsSale: currentProduct.allowsSale,
            isRewardPoint: currentProduct.isRewardPoint,
            description: currentProduct.description,
          },
          {
            name: updatedProduct?.name,
            basePrice: Number(updatedProduct?.basePrice || 0),
            weight: Number(updatedProduct?.weight || 0),
            weightUnit: updatedProduct?.weightUnit,
            unit: updatedProduct?.unit,
            isActive: updatedProduct?.isActive,
            allowsSale: updatedProduct?.allowsSale,
            isRewardPoint: updatedProduct?.isRewardPoint,
            description: updatedProduct?.description,
          },
        );

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PRODUCT_UPDATE',
          entityType: 'products',
          entityId: id.toString(),
          entityCode: updatedProduct?.code || currentProduct.code,
          category: getCategoryFromActionCode('PRODUCT_UPDATE'),
          severity: getSeverityFromActionCode('PRODUCT_UPDATE'),
          snapshot: this.buildProductSnapshot(updatedProduct || currentProduct),
          changes: changes.length > 0 ? changes : null,
          message: renderAuditMessage('PRODUCT_UPDATE', {
            productName: updatedProduct?.name || currentProduct.name,
            productCode: updatedProduct?.code || currentProduct.code,
          }),
          messageTemplate: 'PRODUCT_UPDATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: user?.branchId || undefined,
        });
      }

      this.larkProductSync.enqueueSync(id);

      return tx.product.findUnique({
        where: { id },
        include: {
          variant: true,
          tradeMark: true,
          images: true,
          documents: true,
          inventories: {
            include: { branch: true },
          },
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true },
              },
            },
          },
        },
      });
    });
  }

  async remove(id: number, userId?: number) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { variant: true, tradeMark: true },
    });

    await this.prisma.product.delete({ where: { id } });

    if (userId && product) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRODUCT_DELETE',
        entityType: 'products',
        entityId: id.toString(),
        entityCode: product.code,
        category: getCategoryFromActionCode('PRODUCT_DELETE'),
        severity: getSeverityFromActionCode('PRODUCT_DELETE'),
        snapshot: this.buildProductSnapshot(product),
        message: renderAuditMessage('PRODUCT_DELETE', {
          productName: product.name,
          productCode: product.code,
        }),
        messageTemplate: 'PRODUCT_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return { message: 'Xóa sản phẩm thành công' };
  }

  async findInventoryLogs(
    productId: number,
    branchId?: number,
    page = 1,
    limit = 5,
  ) {
    const where: any = { productId };
    if (branchId) where.branchId = branchId;

    // Lấy toàn bộ log của product (+branch) — số lượng hữu hạn theo product nên
    // chấp nhận đánh đổi để gộp/lọc chính xác trước khi paginate.
    const rawLogs = await this.prisma.inventoryLog.findMany({
      where,
      orderBy: [
        { transactionDate: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    // Bước 1: lọc bỏ log thuộc các chứng từ đã hủy hoặc đã bị xóa cứng.
    // Dùng NGUỒN CHÂN LÝ DUY NHẤT (inventory-onhand.util) để xác định log nào
    // còn hiệu lực — đảm bảo thẻ kho và onHand luôn cùng một bộ lọc.
    const activeKeys = await getActiveLogKeys(this.prisma, rawLogs);
    const activeLogs = rawLogs.filter((log) => isLogActive(log, activeKeys));

    // Bước 2: gộp các log cùng (refType, refCode, transactionType) thành 1 dòng
    // — sum quantity, các trường còn lại lấy theo dòng đại diện (mới nhất).
    // Bỏ qua merge khi refCode rỗng để không vô tình gộp các log "lẻ".
    type LogRow = (typeof activeLogs)[number];
    const mergedMap = new Map<string, LogRow>();
    const ungrouped: LogRow[] = [];

    for (const log of activeLogs) {
      if (!log.refCode) {
        ungrouped.push(log);
        continue;
      }
      const key = `${log.refType}|${log.refCode}|${log.transactionType}`;
      const existing = mergedMap.get(key);
      if (!existing) {
        mergedMap.set(key, { ...log });
      } else {
        // sum quantity (Prisma Decimal hỗ trợ + qua Number cast).
        existing.quantity = (Number(existing.quantity) +
          Number(log.quantity)) as any;
      }
    }

    const merged = [...mergedMap.values(), ...ungrouped]
      // Ẩn dòng đã gộp có tổng số lượng = 0 (vd: nhận rồi hoàn tác nhận, hoặc
      // chuyển rồi hoàn tác chuyển — cặp log đối ứng triệt tiêu nhau). Chỉ áp
      // dụng cho log có refCode (đã qua nhóm), giữ nguyên log lẻ.
      // NGOẠI LỆ: GIỮ dòng phiếu kiểm (STOCK_AUDIT) dù quantity = 0 — đó là mốc
      // neo tuyệt đối "tồn = X" hợp lệ (vd kiểm xác nhận tồn không đổi, hoặc
      // sau re-anchor delta về 0). Ẩn nó sẽ làm mất dòng kiểm trên thẻ kho.
      .filter(
        (log) =>
          !log.refCode ||
          log.transactionType === 'STOCK_AUDIT' ||
          Number(log.quantity) !== 0,
      )
      // Sắp xếp theo thời điểm giao dịch (transactionDate) — hỗ trợ phiếu lùi
      // ngày nằm đúng vị trí trên thẻ kho. createdAt/id làm tiebreak.
      .sort((a, b) => {
        const ta = new Date(a.transactionDate ?? a.createdAt).getTime();
        const tb = new Date(b.transactionDate ?? b.createdAt).getTime();
        if (tb !== ta) return tb - ta;
        const ca = new Date(a.createdAt).getTime();
        const cb = new Date(b.createdAt).getTime();
        if (cb !== ca) return cb - ca;
        return (b.id ?? 0) - (a.id ?? 0);
      });

    // ─── Tính "Tồn cuối" bằng CỘNG DỒN XUÔI theo thời gian ────────────────
    // Đi từ giao dịch CŨ NHẤT → MỚI NHẤT, bắt đầu từ 0 (thuần log-based: thẻ
    // kho chỉ phản ánh các giao dịch đã ghi). Cách này khớp đúng với cách
    // backend tính phiếu kiểm: delta = thực tế − Σ(giao dịch trước đó), nên:
    //   - Dòng "Kiểm hàng" LUÔN hiển thị Tồn cuối = đúng số thực tế đã đếm.
    //   - Tồn cuối mỗi dòng = số dư ngay sau giao dịch đó, tự nhất quán nội bộ.
    // (Trước đây neo ngược từ onHand → khi onHand lệch Σlog (tồn ảo do tạo SP/
    //  sync/import không ghi log) thì phiếu kiểm cũ nhất bị sai lệch.)
    const mergedWithBalance = merged.map(
      (log) => ({ ...log }) as LogRow & { tonCuoi: number },
    );
    let running = 0;
    for (let i = mergedWithBalance.length - 1; i >= 0; i--) {
      running += Number(mergedWithBalance[i].quantity);
      mergedWithBalance[i].tonCuoi = running;
    }

    const total = mergedWithBalance.length;
    const skip = (page - 1) * limit;
    const data = mergedWithBalance.slice(skip, skip + limit);

    return { data, total };
  }

  // ─── Thẻ kho LOẠI TỒN (bucket) — song song findInventoryLogs ───────────
  // Trả về sổ cái StockConditionLog của 1 bucket (DAMAGED/NEAR_EXPIRY/PROMO)
  // kèm "Tồn cuối" cộng dồn xuôi theo transactionDate. Dùng chung bộ lọc active
  // để log thuộc phiếu CLT chưa duyệt / đã hủy bị loại.
  async findConditionLogs(
    productId: number,
    bucket: string,
    branchId?: number,
    page = 1,
    limit = 15,
  ) {
    const where: any = { productId, bucket };
    if (branchId) where.branchId = branchId;

    const rawLogs = await this.prisma.stockConditionLog.findMany({
      where,
      orderBy: [
        { transactionDate: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    const activeKeys = await getActiveLogKeys(this.prisma, rawLogs);
    const activeLogs = rawLogs.filter((log) => isLogActive(log, activeKeys));

    // Cộng dồn xuôi (cũ → mới) để ra tồn cuối từng dòng.
    const withBalance = activeLogs.map(
      (log) => ({ ...log }) as (typeof activeLogs)[number] & { tonCuoi: number },
    );
    let running = 0;
    for (let i = withBalance.length - 1; i >= 0; i--) {
      running += Number(withBalance[i].quantity);
      withBalance[i].tonCuoi = running;
    }

    const total = withBalance.length;
    const skip = (page - 1) * limit;
    const data = withBalance.slice(skip, skip + limit);
    return { data, total };
  }

  // Tồn cận date theo từng lô (expiryDate) — dùng cho bán hàng chọn lô.
  async findNearExpiryLots(productId: number, branchId: number) {
    const lots = await computeNearExpiryLots(this.prisma, productId, branchId);
    return { data: lots };
  }

  // Tồn tổng hợp: Hàng tốt / Bục rách / Cận date / KM. Bất biến:
  //   good + damaged + nearExpiry + promo = onHand
  async getConditionSummary(productId: number, branchId: number) {
    const inv = await this.prisma.inventory.findUnique({
      where: { productId_branchId: { productId, branchId } },
      select: { onHand: true },
    });
    const onHand = inv ? Number(inv.onHand) : 0;
    const totals = await computeBucketTotals(this.prisma, productId, branchId);
    const good =
      onHand - totals.damaged - totals.nearExpiry - totals.promo;
    return {
      productId,
      branchId,
      onHand,
      good,
      damaged: totals.damaged,
      nearExpiry: totals.nearExpiry,
      promo: totals.promo,
    };
  }

  // Tồn bucket cho NHIỀU sản phẩm trong 1 chi nhánh — đọc TỪ SỔ CÁI.
  // Dùng cho dropdown bán hàng: trước đây FE đọc cache Inventory
  // (damagedQuantity/nearExpiryQuantity/promoQuantity) nên bị lệch khi cache
  // trôi khỏi sổ cái. Nay dropdown đọc endpoint này → một nguồn chân lý duy nhất.
  async getConditionSummaryBatch(productIds: number[], branchId: number) {
    const ids = [...new Set((productIds || []).filter((id) => !!id))];
    if (ids.length === 0 || !branchId) {
      return {} as Record<
        number,
        { damaged: number; nearExpiry: number; promo: number }
      >;
    }

    const totalsMap = await computeBucketTotalsBatch(
      this.prisma,
      ids,
      branchId,
    );

    const result: Record<
      number,
      { damaged: number; nearExpiry: number; promo: number }
    > = {};
    for (const id of ids) {
      const t = totalsMap[id] || { damaged: 0, nearExpiry: 0, promo: 0 };
      result[id] = {
        damaged: t.damaged,
        nearExpiry: t.nearExpiry,
        promo: t.promo,
      };
    }
    return result;
  }

  async checkLowStock() {
    const allInventories = await this.prisma.inventory.findMany({
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return allInventories.filter(
      (inv) => Number(inv.onHand) <= Number(inv.minQuality),
    );
  }

  /**
   * RECONCILE-CHECK (CHỈ ĐỌC — không ghi gì).
   * So sánh Inventory.onHand đã lưu vs Σ log ACTIVE (nguồn chân lý từ
   * inventory-onhand.util). Trả về danh sách (product, branch) bị LỆCH để
   * giám sát drift. Dùng cùng bộ lọc getActiveLogKeys/isLogActive như thẻ kho
   * và recalcInventoryOnHand → kết quả khớp tuyệt đối với cách hệ thống định
   * nghĩa tồn kho.
   *
   * @param productId  (tùy chọn) chỉ kiểm 1 sản phẩm.
   */
  async reconcileCheck(productId?: number) {
    const invWhere: any = {};
    if (productId) invWhere.productId = productId;

    const inventories = await this.prisma.inventory.findMany({
      where: invWhere,
      select: {
        productId: true,
        branchId: true,
        onHand: true,
        product: { select: { code: true, name: true } },
        branch: { select: { name: true } },
      },
    });

    // Tải toàn bộ log liên quan 1 lần (theo productId nếu có) rồi tính
    // activeKeys chung — tránh N+1 query như gọi computeOnHandFromLogs từng cặp.
    const logWhere: any = {};
    if (productId) logWhere.productId = productId;
    const logs = await this.prisma.inventoryLog.findMany({
      where: logWhere,
      select: {
        productId: true,
        branchId: true,
        quantity: true,
        refType: true,
        refId: true,
      },
    });

    const activeKeys = await getActiveLogKeys(this.prisma, logs);

    // Σ quantity log active theo cặp (productId|branchId).
    const sumMap = new Map<string, number>();
    for (const l of logs) {
      if (!isLogActive(l, activeKeys)) continue;
      const key = `${l.productId}|${l.branchId}`;
      sumMap.set(key, (sumMap.get(key) ?? 0) + Number(l.quantity));
    }

    const mismatches: Array<{
      productId: number;
      branchId: number;
      productCode: string;
      productName: string;
      branchName: string;
      onHand: number;
      sumLogs: number;
      diff: number;
    }> = [];

    for (const inv of inventories) {
      const key = `${inv.productId}|${inv.branchId}`;
      const onHand = Number(inv.onHand);
      const sumLogs = sumMap.get(key) ?? 0;
      const diff = onHand - sumLogs;
      if (diff !== 0) {
        mismatches.push({
          productId: inv.productId,
          branchId: inv.branchId,
          productCode: inv.product?.code ?? '',
          productName: inv.product?.name ?? '',
          branchName: inv.branch?.name ?? '',
          onHand,
          sumLogs,
          diff,
        });
      }
    }

    mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    return {
      checkedInventories: inventories.length,
      mismatchCount: mismatches.length,
      mismatches,
    };
  }

  /**
   * Sinh mã sản phẩm duy nhất theo pattern `SP{NNNNNN}`.
   * Được promote từ `private` sang method công khai để ImportService
   * có thể dùng khi tạo sản phẩm mới qua file Excel mà người dùng
   * không nhập mã. Truyền `tx` để đảm bảo thao tác nằm trong cùng
   * transaction với create, tránh trùng mã do race condition.
   */
  async generateSafeProductCode(tx: any): Promise<string> {
    const prefix = 'SP';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allProducts = await tx.product.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allProducts
        .map((prod: any) => prod.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.product.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã sản phẩm duy nhất');
  }

  private async syncProductInfoToInventories(
    productId: number,
    newCode: string,
    newName: string,
    tx: any,
  ) {
    await tx.inventory.updateMany({
      where: { productId },
      data: {
        productCode: newCode,
        productName: newName,
      },
    });
  }

  private buildProductSnapshot(product: any) {
    return {
      code: product.code,
      name: product.name,
      fullName: product.fullName,
      basePrice: product.basePrice ? Number(product.basePrice) : 0,
      weight: product.weight ? Number(product.weight) : 0,
      weightUnit: product.weightUnit,
      vat:
        product.vat !== null && product.vat !== undefined
          ? Number(product.vat)
          : 8,
      shippingWeight:
        product.shippingWeight !== null && product.shippingWeight !== undefined
          ? Number(product.shippingWeight)
          : null,
      shippingWeightUnit: product.shippingWeightUnit ?? 'g',
      unit: product.unit,
      type: product.type,
      isActive: product.isActive,
      allowsSale: product.allowsSale,
      isRewardPoint: product.isRewardPoint,
      isDirectSale: product.isDirectSale,
      description: product.description,
      variant: product.variant ? { name: product.variant.name } : null,
      tradeMark: product.tradeMark ? { name: product.tradeMark.name } : null,
    };
  }
}
