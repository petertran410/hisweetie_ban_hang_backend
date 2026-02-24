import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AllPackingQueryDto } from './dto/all-packing-query.dto';

@Injectable()
export class AllPackingService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: AllPackingQueryDto) {
    const { branchId, type, search, limit, pageSize, currentItem = 0 } = query;
    const take = limit || pageSize || 15;

    let allData: any[] = [];
    let total = 0;

    if (!type || type === 'all') {
      const [packingSlips, packingHangs, packingLoadings] = await Promise.all([
        this.getPackingSlips(branchId, search),
        this.getPackingHangs(branchId, search),
        this.getPackingLoadings(branchId, search),
      ]);

      allData = [
        ...packingSlips.map((item) => ({ ...item, type: 'giao-hang' })),
        ...packingHangs.map((item) => ({ ...item, type: 'dong-hang' })),
        ...packingLoadings.map((item) => ({ ...item, type: 'loading' })),
      ];
    } else if (type === 'giao-hang') {
      const packingSlips = await this.getPackingSlips(branchId, search);
      allData = packingSlips.map((item) => ({ ...item, type: 'giao-hang' }));
    } else if (type === 'dong-hang') {
      const packingHangs = await this.getPackingHangs(branchId, search);
      allData = packingHangs.map((item) => ({ ...item, type: 'dong-hang' }));
    } else if (type === 'loading') {
      const packingLoadings = await this.getPackingLoadings(branchId, search);
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

  private async getPackingSlips(branchId?: number, search?: string) {
    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.packingSlip.findMany({
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

  private async getPackingHangs(branchId?: number, search?: string) {
    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
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
          },
        },
        images: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getPackingLoadings(branchId?: number, search?: string) {
    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
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
          },
        },
        images: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
