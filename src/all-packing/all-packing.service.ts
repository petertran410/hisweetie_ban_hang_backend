import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AllPackingQueryDto } from './dto/all-packing-query.dto';
import { searchCustomerIds } from '../common/customer-search.util';
import {
  buildColdCargoWarning,
  summarizeColdCargoWarning,
  type ColdCargoWarning,
} from '../common/cold-cargo.util';

const PACKING_SLIP_LIST_SELECT = {
  id: true,
  code: true,
  branchId: true,
  numberOfPackages: true,
  paymentMethod: true,
  cashAmount: true,
  hasFeeGuiBen: true,
  feeGuiBen: true,
  hasFeeGrab: true,
  feeGrab: true,
  hasCuocGuiHang: true,
  cuocGuiHang: true,
  hasCuocNhanHang: true,
  cuocNhanHang: true,
  note: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  cancelledById: true,
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  expensePayer: { select: { id: true, name: true, larkUserId: true } },
  invoices: {
    select: {
      id: true,
      invoice: {
        select: {
          id: true,
          code: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
      consignment: {
        select: {
          id: true,
          code: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
    },
  },
  _count: {
    select: {
      images: true,
      expenseFiles: true,
    },
  },
} as const;

const PACKING_HANG_LIST_SELECT = {
  id: true,
  code: true,
  branchId: true,
  numberOfPackages: true,
  note: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  cancelledById: true,
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  invoices: {
    select: {
      id: true,
      invoice: {
        select: {
          id: true,
          code: true,
          customerId: true,
          purchaseDate: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
      consignment: {
        select: {
          id: true,
          code: true,
          customerId: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
    },
  },
  _count: {
    select: {
      images: true,
    },
  },
} as const;

const PACKING_LOADING_LIST_SELECT = {
  id: true,
  code: true,
  branchId: true,
  loadingById: true,
  numberOfPackages: true,
  note: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  cancelledById: true,
  branch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  loadingBy: { select: { id: true, name: true } },
  invoices: {
    select: {
      id: true,
      invoice: {
        select: {
          id: true,
          code: true,
          customerId: true,
          purchaseDate: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
      consignment: {
        select: {
          id: true,
          code: true,
          customerId: true,
          grandTotal: true,
          customer: {
            select: { id: true, name: true, contactNumber: true },
          },
        },
      },
    },
  },
  _count: {
    select: {
      images: true,
    },
  },
} as const;

@Injectable()
export class AllPackingService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: AllPackingQueryDto, currentUser?: any) {
    const {
      branchId,
      branchIds,
      type,
      search,
      invoiceSearch,
      customerSearch,
      paymentMethod,
      fromCreatedDate,
      toCreatedDate,
      limit,
      pageSize,
      currentItem = 0,
    } = query;
    const take = limit || pageSize || 15;

    // Resolve branch filter: branchIds takes priority over branchId
    const effectiveBranchIds = branchIds?.length
      ? branchIds
      : branchId
        ? [branchId]
        : undefined;

    // Khoảng thời gian tạo (createdAt) — áp dụng cho cả 3 loại packing.
    const createdDateRange =
      fromCreatedDate || toCreatedDate
        ? {
            gte: fromCreatedDate ? new Date(fromCreatedDate) : undefined,
            lte: toCreatedDate ? new Date(toCreatedDate) : undefined,
          }
        : undefined;

    // Nếu user bị giới hạn chỉ xem báo đơn của chính mình → filter createdBy
    const ownerFilterId =
      currentUser && currentUser.canViewOnlyOwnPackings
        ? currentUser.id
        : undefined;

   // Khớp khách hàng theo từ trọn vẹn (dùng chung util). Resolve 1 lần rồi
   // truyền id xuống 3 nhánh để tránh query trùng.
   const customerMatchedIds = customerSearch
     ? await searchCustomerIds(this.prisma, customerSearch)
     : undefined;

    const whereSlips = this.buildWhereSlips(
      effectiveBranchIds,
      search,
      invoiceSearch,
      customerMatchedIds,
      ownerFilterId,
      paymentMethod,
      createdDateRange,
    );

    // Nếu có paymentMethod hoặc type === 'giao-hang' → chỉ truy vấn packing_slips.
    if (paymentMethod || type === 'giao-hang') {
      const [items, total] = await Promise.all([
        this.prisma.packingSlip.findMany({
          where: whereSlips,
          select: PACKING_SLIP_LIST_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: currentItem,
          take,
        }),
        this.prisma.packingSlip.count({ where: whereSlips }),
      ]);
      const coldWarnings = await this.getColdWarningsByPackingItems(
        items.map((item) => ({
          key: `giao-hang:${item.id}`,
          invoices: item.invoices,
        })),
      );
      return {
        data: items.map((item) =>
          this.mapPackingSlip(
            item,
            coldWarnings.get(`giao-hang:${item.id}`),
          ),
        ),
        total,
      };
    }

    if (type === 'dong-hang') {
      const whereHangs = this.buildWhereHangs(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        createdDateRange,
      );
      const [items, total] = await Promise.all([
        this.prisma.packingHang.findMany({
          where: whereHangs,
          select: PACKING_HANG_LIST_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: currentItem,
          take,
        }),
        this.prisma.packingHang.count({ where: whereHangs }),
      ]);
      const coldWarnings = await this.getColdWarningsByPackingItems(
        items.map((item) => ({
          key: `dong-hang:${item.id}`,
          invoices: item.invoices,
        })),
      );
      return {
        data: items.map((item) =>
          this.mapPackingHang(
            item,
            coldWarnings.get(`dong-hang:${item.id}`),
          ),
        ),
        total,
      };
    }

    if (type === 'loading') {
      const whereLoadings = this.buildWhereLoadings(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        createdDateRange,
      );
      const [items, total] = await Promise.all([
        this.prisma.packingLoading.findMany({
          where: whereLoadings,
          select: PACKING_LOADING_LIST_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: currentItem,
          take,
        }),
        this.prisma.packingLoading.count({ where: whereLoadings }),
      ]);
      const coldWarnings = await this.getColdWarningsByPackingItems(
        items.map((item) => ({
          key: `loading:${item.id}`,
          invoices: item.invoices,
        })),
      );
      return {
        data: items.map((item) =>
          this.mapPackingLoading(
            item,
            coldWarnings.get(`loading:${item.id}`),
          ),
        ),
        total,
      };
    }

    // type === 'all' hoặc không truyền
    const whereHangs = this.buildWhereHangs(
      effectiveBranchIds,
      search,
      invoiceSearch,
      customerMatchedIds,
      ownerFilterId,
      createdDateRange,
    );
    const whereLoadings = this.buildWhereLoadings(
      effectiveBranchIds,
      search,
      invoiceSearch,
      customerMatchedIds,
      ownerFilterId,
      createdDateRange,
    );

    const [countSlips, countHangs, countLoadings] = await Promise.all([
      this.prisma.packingSlip.count({ where: whereSlips }),
      this.prisma.packingHang.count({ where: whereHangs }),
      this.prisma.packingLoading.count({ where: whereLoadings }),
    ]);
    const total = countSlips + countHangs + countLoadings;
    if (total === 0 || currentItem >= total) {
      return { data: [], total };
    }

    // Lấy danh sách ID + createdAt của các dòng có khả năng thuộc trang hiện tại
    const needed = currentItem + take;
    const [slipKeys, hangKeys, loadingKeys] = await Promise.all([
      countSlips > 0
        ? this.prisma.packingSlip.findMany({
            where: whereSlips,
            select: { id: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: needed,
          })
        : [],
      countHangs > 0
        ? this.prisma.packingHang.findMany({
            where: whereHangs,
            select: { id: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: needed,
          })
        : [],
      countLoadings > 0
        ? this.prisma.packingLoading.findMany({
            where: whereLoadings,
            select: { id: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: needed,
          })
        : [],
    ]);

    const combinedKeys = [
      ...slipKeys.map((k) => ({
        id: k.id,
        createdAt: k.createdAt,
        type: 'giao-hang' as const,
      })),
      ...hangKeys.map((k) => ({
        id: k.id,
        createdAt: k.createdAt,
        type: 'dong-hang' as const,
      })),
      ...loadingKeys.map((k) => ({
        id: k.id,
        createdAt: k.createdAt,
        type: 'loading' as const,
      })),
    ];

    combinedKeys.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        b.id - a.id,
    );

    const pageKeys = combinedKeys.slice(currentItem, currentItem + take);
    const pageSlipIds = pageKeys
      .filter((k) => k.type === 'giao-hang')
      .map((k) => k.id);
    const pageHangIds = pageKeys
      .filter((k) => k.type === 'dong-hang')
      .map((k) => k.id);
    const pageLoadingIds = pageKeys
      .filter((k) => k.type === 'loading')
      .map((k) => k.id);

    // Chỉ tải đầy đủ quan hệ cho đúng các bản ghi hiển thị trên trang hiện tại
    const [pageSlips, pageHangs, pageLoadings] = await Promise.all([
      pageSlipIds.length > 0
        ? this.prisma.packingSlip.findMany({
            where: { id: { in: pageSlipIds } },
            select: PACKING_SLIP_LIST_SELECT,
          })
        : [],
      pageHangIds.length > 0
        ? this.prisma.packingHang.findMany({
            where: { id: { in: pageHangIds } },
            select: PACKING_HANG_LIST_SELECT,
          })
        : [],
      pageLoadingIds.length > 0
        ? this.prisma.packingLoading.findMany({
            where: { id: { in: pageLoadingIds } },
            select: PACKING_LOADING_LIST_SELECT,
          })
        : [],
    ]);

    const coldWarnings = await this.getColdWarningsByPackingItems([
      ...pageSlips.map((item) => ({
        key: `giao-hang:${item.id}`,
        invoices: item.invoices,
      })),
      ...pageHangs.map((item) => ({
        key: `dong-hang:${item.id}`,
        invoices: item.invoices,
      })),
      ...pageLoadings.map((item) => ({
        key: `loading:${item.id}`,
        invoices: item.invoices,
      })),
    ]);

    const slipMap = new Map(
      pageSlips.map(
        (s) =>
          [s.id, this.mapPackingSlip(s, coldWarnings.get(`giao-hang:${s.id}`))] as [
            number,
            any,
          ],
      ),
    );
    const hangMap = new Map(
      pageHangs.map(
        (h) =>
          [h.id, this.mapPackingHang(h, coldWarnings.get(`dong-hang:${h.id}`))] as [
            number,
            any,
          ],
      ),
    );
    const loadingMap = new Map(
      pageLoadings.map(
        (l) =>
          [l.id, this.mapPackingLoading(l, coldWarnings.get(`loading:${l.id}`))] as [
            number,
            any,
          ],
      ),
    );

    const paginatedData = pageKeys
      .map((k) => {
        if (k.type === 'giao-hang') return slipMap.get(k.id);
        if (k.type === 'dong-hang') return hangMap.get(k.id);
        return loadingMap.get(k.id);
      })
      .filter(Boolean);

    return { data: paginatedData, total };
  }

  private mapPackingSlip(
    item: any,
    coldWarning: Pick<ColdCargoWarning, 'hasColdItems' | 'coldItemCount'> = {
      hasColdItems: false,
      coldItemCount: 0,
    },
  ) {
    const imageCount = item._count?.images ?? 0;
    const expenseFileCount = item._count?.expenseFiles ?? 0;
    return {
      ...item,
      ...coldWarning,
      type: 'giao-hang' as const,
      imageCount,
      expenseFileCount,
      images: Array.from({ length: imageCount }, (_, i) => ({ id: i })),
      expenseFiles: Array.from({ length: expenseFileCount }, (_, i) => ({
        id: i,
      })),
    };
  }

  private mapPackingHang(
    item: any,
    coldWarning: Pick<ColdCargoWarning, 'hasColdItems' | 'coldItemCount'> = {
      hasColdItems: false,
      coldItemCount: 0,
    },
  ) {
    const imageCount = item._count?.images ?? 0;
    return {
      ...item,
      ...coldWarning,
      type: 'dong-hang' as const,
      imageCount,
      expenseFileCount: 0,
      images: Array.from({ length: imageCount }, (_, i) => ({ id: i })),
      expenseFiles: [],
    };
  }

  private mapPackingLoading(
    item: any,
    coldWarning: Pick<ColdCargoWarning, 'hasColdItems' | 'coldItemCount'> = {
      hasColdItems: false,
      coldItemCount: 0,
    },
  ) {
    const imageCount = item._count?.images ?? 0;
    return {
      ...item,
      ...coldWarning,
      type: 'loading' as const,
      imageCount,
      expenseFileCount: 0,
      images: Array.from({ length: imageCount }, (_, i) => ({ id: i })),
      expenseFiles: [],
    };
  }

  private async getColdWarningsByPackingItems(
    items: Array<{ key: string; invoices?: readonly any[] | null }>,
  ) {
    const invoiceIds = [
      ...new Set(
        items.flatMap((item) =>
          (Array.isArray(item.invoices) ? item.invoices : [])
            .map((entry) => Number(entry?.invoice?.id))
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      ),
    ];

    const coldDetails =
      invoiceIds.length > 0
        ? await this.prisma.invoiceDetail.findMany({
            where: {
              invoiceId: { in: invoiceIds },
              product: { cargoType: 'COLD' },
            },
            select: {
              invoiceId: true,
              productId: true,
              productCode: true,
              productName: true,
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  cargoType: true,
                },
              },
            },
          })
        : [];

    const detailsByInvoice = new Map<number, any[]>();
    for (const detail of coldDetails) {
      const details = detailsByInvoice.get(detail.invoiceId) || [];
      details.push(detail);
      detailsByInvoice.set(detail.invoiceId, details);
    }

    const warnings = new Map<
      string,
      Pick<ColdCargoWarning, 'hasColdItems' | 'coldItemCount'>
    >();

    for (const item of items) {
      const hydratedInvoices = (Array.isArray(item.invoices)
        ? item.invoices
        : []
      ).map((entry) => {
        if (!entry?.invoice) return entry;
        return {
          ...entry,
          invoice: {
            ...entry.invoice,
            details: detailsByInvoice.get(entry.invoice.id) || [],
          },
        };
      });
      warnings.set(
        item.key,
        summarizeColdCargoWarning(buildColdCargoWarning(hydratedInvoices)),
      );
    }

    return warnings;
  }

  private buildWhereSlips(
    branchIds?: number[],
    search?: string,
    invoiceSearch?: string,
    customerMatchedIds?: number[],
    ownerFilterId?: number,
    paymentMethod?: string,
    createdDateRange?: { gte?: Date; lte?: Date },
  ) {
    const where: any = {};

    if (branchIds?.length) {
      where.branchId = { in: branchIds };
    }

    if (ownerFilterId) {
      where.createdBy = ownerFilterId;
    }

    // Chỉ PackingSlip có paymentMethod (cash | transfer).
    if (paymentMethod) {
      where.paymentMethod = paymentMethod;
    }

    // Lọc theo thời gian tạo (createdAt).
    if (createdDateRange) {
      where.createdAt = {};
      if (createdDateRange.gte) where.createdAt.gte = createdDateRange.gte;
      if (createdDateRange.lte) where.createdAt.lte = createdDateRange.lte;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (invoiceSearch) {
      where.invoices = {
        some: {
          invoice: { code: { contains: invoiceSearch, mode: 'insensitive' } },
        },
      };
    }

    if (customerMatchedIds) {
      const ids = customerMatchedIds.length > 0 ? customerMatchedIds : [-1];
      where.invoices = {
        ...where.invoices,
        some: {
          ...(where.invoices?.some || {}),
          invoice: {
            ...(where.invoices?.some?.invoice || {}),
            customerId: { in: ids },
          },
        },
      };
    }

    return where;
  }

  private buildWhereHangs(
    branchIds?: number[],
    search?: string,
    invoiceSearch?: string,
    customerMatchedIds?: number[],
    ownerFilterId?: number,
    createdDateRange?: { gte?: Date; lte?: Date },
  ) {
    const where: any = {};

    if (branchIds?.length) {
      where.branchId = { in: branchIds };
    }

    if (ownerFilterId) {
      where.createdBy = ownerFilterId;
    }

    // Lọc theo thời gian tạo (createdAt).
    if (createdDateRange) {
      where.createdAt = {};
      if (createdDateRange.gte) where.createdAt.gte = createdDateRange.gte;
      if (createdDateRange.lte) where.createdAt.lte = createdDateRange.lte;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (invoiceSearch) {
      where.invoices = {
        some: {
          invoice: { code: { contains: invoiceSearch, mode: 'insensitive' } },
        },
      };
    }

    if (customerMatchedIds) {
      const ids = customerMatchedIds.length > 0 ? customerMatchedIds : [-1];
      where.invoices = {
        ...where.invoices,
        some: {
          ...(where.invoices?.some || {}),
          invoice: {
            ...(where.invoices?.some?.invoice || {}),
            customerId: { in: ids },
          },
        },
      };
    }

    return where;
  }

  private buildWhereLoadings(
    branchIds?: number[],
    search?: string,
    invoiceSearch?: string,
    customerMatchedIds?: number[],
    ownerFilterId?: number,
    createdDateRange?: { gte?: Date; lte?: Date },
  ) {
    const where: any = {};

    if (branchIds?.length) {
      where.branchId = { in: branchIds };
    }

    if (ownerFilterId) {
      where.createdBy = ownerFilterId;
    }

    // Lọc theo thời gian tạo (createdAt).
    if (createdDateRange) {
      where.createdAt = {};
      if (createdDateRange.gte) where.createdAt.gte = createdDateRange.gte;
      if (createdDateRange.lte) where.createdAt.lte = createdDateRange.lte;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (invoiceSearch) {
      where.invoices = {
        some: {
          invoice: { code: { contains: invoiceSearch, mode: 'insensitive' } },
        },
      };
    }

    if (customerMatchedIds) {
      const ids = customerMatchedIds.length > 0 ? customerMatchedIds : [-1];
      where.invoices = {
        ...where.invoices,
        some: {
          ...(where.invoices?.some || {}),
          invoice: {
            ...(where.invoices?.some?.invoice || {}),
            customerId: { in: ids },
          },
        },
      };
    }

    return where;
  }
}
