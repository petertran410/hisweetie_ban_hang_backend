import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingLoadingDto,
  UpdatePackingLoadingDto,
  PackingLoadingQueryDto,
} from './dto';

@Injectable()
export class PackingLoadingsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: PackingLoadingQueryDto) {
    const {
      branchId,
      invoiceId,
      search,
      limit,
      pageSize,
      currentItem = 0,
    } = query;
    const take = limit || pageSize || 15;

    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (invoiceId) {
      where.invoices = {
        some: {
          invoiceId: invoiceId,
        },
      };
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.packingLoading.findMany({
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
        skip: currentItem,
        take: take,
      }),
      this.prisma.packingLoading.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const packingLoading = await this.prisma.packingLoading.findUnique({
      where: { id },
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
    });

    if (!packingLoading) {
      throw new NotFoundException(`Packing loading with ID ${id} not found`);
    }

    return packingLoading;
  }

  async create(dto: CreatePackingLoadingDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: {
          id: { in: dto.invoiceIds },
        },
        select: {
          id: true,
          branchId: true,
        },
      });

      if (invoices.length === 0) {
        throw new BadRequestException('Không tìm thấy hóa đơn');
      }

      const firstBranchId = invoices[0].branchId;
      const hasDifferentBranch = invoices.some(
        (inv) => inv.branchId !== firstBranchId,
      );

      if (hasDifferentBranch) {
        throw new BadRequestException('Các hóa đơn phải cùng chi nhánh');
      }

      const code = await this.generateCode(tx);

      const packingLoading = await tx.packingLoading.create({
        data: {
          code,
          branchId: dto.branchId,
          loadingById: dto.loadingById,
          numberOfPackages: dto.numberOfPackages,
          note: dto.note,
          createdBy: userId,
          invoices: {
            create: dto.invoiceIds.map((invoiceId) => ({
              invoiceId,
            })),
          },
          images: dto.imageUrls
            ? {
                create: dto.imageUrls.map((url) => ({
                  imageUrl: url,
                })),
              }
            : undefined,
        },
        include: {
          branch: true,
          creator: true,
          loadingBy: true,
          invoices: {
            include: {
              invoice: true,
            },
          },
          images: true,
        },
      });

      return packingLoading;
    });
  }

  async update(id: number, dto: UpdatePackingLoadingDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      if (dto.invoiceIds) {
        const invoices = await tx.invoice.findMany({
          where: {
            id: { in: dto.invoiceIds },
          },
          select: {
            id: true,
            branchId: true,
          },
        });

        const firstBranchId = invoices[0].branchId;
        const hasDifferentBranch = invoices.some(
          (inv) => inv.branchId !== firstBranchId,
        );

        if (hasDifferentBranch) {
          throw new BadRequestException('Các hóa đơn phải cùng chi nhánh');
        }
      }

      const updateData: any = {
        branchId: dto.branchId,
        loadingById: dto.loadingById,
        numberOfPackages: dto.numberOfPackages,
        note: dto.note,
      };

      if (dto.invoiceIds) {
        await tx.packingLoadingInvoice.deleteMany({
          where: { packingLoadingId: id },
        });
        updateData.invoices = {
          create: dto.invoiceIds.map((invoiceId) => ({
            invoiceId,
          })),
        };
      }

      if (dto.imageUrls) {
        await tx.packingLoadingImage.deleteMany({
          where: { packingLoadingId: id },
        });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({
            imageUrl: url,
          })),
        };
      }

      const updated = await tx.packingLoading.update({
        where: { id },
        data: updateData,
        include: {
          branch: true,
          creator: true,
          loadingBy: true,
          invoices: {
            include: {
              invoice: true,
            },
          },
          images: true,
        },
      });

      return updated;
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.packingLoading.delete({
      where: { id },
    });
  }

  private async generateCode(tx: any): Promise<string> {
    const lastPackingLoading = await tx.packingLoading.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastPackingLoading) {
      const match = lastPackingLoading.code.match(/DLD(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `LD${nextNumber.toString().padStart(6, '0')}`;
  }
}
