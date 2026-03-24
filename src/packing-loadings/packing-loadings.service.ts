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
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class PackingLoadingsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PACKING_LOADING_CREATE',
        entityType: 'packing_loadings',
        entityId: packingLoading.id.toString(),
        entityCode: packingLoading.code,
        category: getCategoryFromActionCode('PACKING_LOADING_CREATE'),
        severity: getSeverityFromActionCode('PACKING_LOADING_CREATE'),
        snapshot: this.buildPackingLoadingSnapshot(packingLoading),
        message: renderAuditMessage('PACKING_LOADING_CREATE', {
          packingCode: packingLoading.code,
        }),
        messageTemplate: 'PACKING_LOADING_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingLoading.branchId || undefined,
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

  async remove(id: number, userId?: number) {
    const packingLoading = await this.findOne(id);

    await this.prisma.packingLoading.delete({
      where: { id },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PACKING_LOADING_DELETE',
        entityType: 'packing_loadings',
        entityId: id.toString(),
        entityCode: packingLoading.code,
        category: getCategoryFromActionCode('PACKING_LOADING_DELETE'),
        severity: getSeverityFromActionCode('PACKING_LOADING_DELETE'),
        snapshot: this.buildPackingLoadingSnapshot(packingLoading),
        message: renderAuditMessage('PACKING_LOADING_DELETE', {
          packingCode: packingLoading.code,
        }),
        messageTemplate: 'PACKING_LOADING_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingLoading.branchId || undefined,
      });
    }

    return { message: 'Xóa phiếu xếp hàng lên xe thành công' };
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

    return `DLD${nextNumber.toString().padStart(6, '0')}`;
  }

  private buildPackingLoadingSnapshot(pl: any) {
    return {
      code: pl.code,
      branchId: pl.branchId,
      branchName: pl.branch?.name,
      loadingByName: pl.loadingBy?.name,
      numberOfPackages: pl.numberOfPackages,
      note: pl.note,
      invoices: (pl.invoices || []).map((i: any) => ({
        invoiceId: i.invoiceId,
        invoiceCode: i.invoice?.code,
      })),
    };
  }
}
