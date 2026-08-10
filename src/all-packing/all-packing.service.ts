import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AllPackingQueryDto } from './dto/all-packing-query.dto';
import { searchCustomerIds } from '../common/customer-search.util';

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

    let allData: any[] = [];
    let total = 0;

    // Khi lọc theo paymentMethod → chỉ PackingSlip (giao hàng) có trường này.
    // PackingHang (đóng hàng) & PackingLoading (loading) không có paymentMethod
    // nên bị loại bỏ hoàn toàn, bất kể `type` được chọn là gì.
    if (paymentMethod) {
      const packingSlips = await this.getPackingSlips(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        paymentMethod,
        createdDateRange,
      );
      allData = packingSlips.map((item) => ({ ...item, type: 'giao-hang' }));
    } else if (!type || type === 'all') {
      const [packingSlips, packingHangs, packingLoadings] = await Promise.all([
        this.getPackingSlips(
          effectiveBranchIds,
          search,
          invoiceSearch,
          customerMatchedIds,
          ownerFilterId,
          undefined,
          createdDateRange,
        ),
        this.getPackingHangs(
          effectiveBranchIds,
          search,
          invoiceSearch,
          customerMatchedIds,
          ownerFilterId,
          createdDateRange,
        ),
        this.getPackingLoadings(
          effectiveBranchIds,
          search,
          invoiceSearch,
          customerMatchedIds,
          ownerFilterId,
          createdDateRange,
        ),
      ]);

      allData = [
        ...packingSlips.map((item) => ({ ...item, type: 'giao-hang' })),
        ...packingHangs.map((item) => ({ ...item, type: 'dong-hang' })),
        ...packingLoadings.map((item) => ({ ...item, type: 'loading' })),
      ];
    } else if (type === 'giao-hang') {
      const packingSlips = await this.getPackingSlips(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        undefined,
        createdDateRange,
      );
      allData = packingSlips.map((item) => ({ ...item, type: 'giao-hang' }));
    } else if (type === 'dong-hang') {
      const packingHangs = await this.getPackingHangs(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        createdDateRange,
      );
      allData = packingHangs.map((item) => ({ ...item, type: 'dong-hang' }));
    } else if (type === 'loading') {
      const packingLoadings = await this.getPackingLoadings(
        effectiveBranchIds,
        search,
        invoiceSearch,
        customerMatchedIds,
        ownerFilterId,
        createdDateRange,
      );
      allData = packingLoadings.map((item) => ({
        ...item,
        type: 'loading',
      }));
    }

    allData.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    total = allData.length;
    const paginatedData = allData.slice(currentItem, currentItem + take);

    return { data: paginatedData, total };
  }

  private async getPackingSlips(
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

    return this.prisma.packingSlip.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        expensePayer: { select: { id: true, name: true, larkUserId: true } },
        invoices: {
          include: {
            invoice: {
              select: {
                id: true,
                code: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
            consignment: {
              select: {
                id: true,
                code: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
          },
        },
        images: true,
        expenseFiles: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getPackingHangs(
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

    return this.prisma.packingHang.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        invoices: {
          include: {
            invoice: {
              select: {
                id: true,
                code: true,
                customerId: true,
                purchaseDate: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
            consignment: {
              select: {
                id: true,
                code: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
          },
        },
        images: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getPackingLoadings(
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

    return this.prisma.packingLoading.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        loadingBy: { select: { id: true, name: true } },
        invoices: {
          include: {
            invoice: {
              select: {
                id: true,
                code: true,
                customerId: true,
                purchaseDate: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
            consignment: {
              select: {
                id: true,
                code: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
          },
        },
        images: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
