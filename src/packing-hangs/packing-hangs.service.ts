import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingHangDto,
  UpdatePackingHangDto,
  PackingHangQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { INVOICE_STATUS, getStatusLabel } from 'src/invoices/dto';

@Injectable()
export class PackingHangsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: PackingHangQueryDto) {
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
      this.prisma.packingHang.findMany({
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
        skip: currentItem,
        take: take,
      }),
      this.prisma.packingHang.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const packingHang = await this.prisma.packingHang.findUnique({
      where: { id },
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
    });

    if (!packingHang) {
      throw new NotFoundException(`Packing hang with ID ${id} not found`);
    }

    return packingHang;
  }

  async create(dto: CreatePackingHangDto, userId: number) {
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

      const packingHang = await tx.packingHang.create({
        data: {
          code,
          branchId: dto.branchId,
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

      await tx.invoice.updateMany({
        where: {
          id: { in: dto.invoiceIds },
          status: {
            notIn: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.COMPLETED],
          },
        },
        data: {
          status: INVOICE_STATUS.PACKED,
          statusValue: getStatusLabel(INVOICE_STATUS.PACKED),
        },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PACKING_HANG_CREATE',
        entityType: 'packing_hangs',
        entityId: packingHang.id.toString(),
        entityCode: packingHang.code,
        category: getCategoryFromActionCode('PACKING_HANG_CREATE'),
        severity: getSeverityFromActionCode('PACKING_HANG_CREATE'),
        snapshot: this.buildPackingHangSnapshot(packingHang),
        message: renderAuditMessage('PACKING_HANG_CREATE', {
          packingCode: packingHang.code,
        }),
        messageTemplate: 'PACKING_HANG_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingHang.branchId || undefined,
      });

      return packingHang;
    });
  }

  async update(id: number, dto: UpdatePackingHangDto) {
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
        numberOfPackages: dto.numberOfPackages,
        note: dto.note,
      };

      if (dto.invoiceIds) {
        await tx.packingHangInvoice.deleteMany({
          where: { packingHangId: id },
        });
        updateData.invoices = {
          create: dto.invoiceIds.map((invoiceId) => ({
            invoiceId,
          })),
        };
      }

      if (dto.imageUrls) {
        await tx.packingHangImage.deleteMany({
          where: { packingHangId: id },
        });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({
            imageUrl: url,
          })),
        };
      }

      const updated = await tx.packingHang.update({
        where: { id },
        data: updateData,
        include: {
          branch: true,
          creator: true,
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
    const packingHang = await this.findOne(id);

    await this.prisma.packingHang.delete({
      where: { id },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PACKING_HANG_DELETE',
        entityType: 'packing_hangs',
        entityId: id.toString(),
        entityCode: packingHang.code,
        category: getCategoryFromActionCode('PACKING_HANG_DELETE'),
        severity: getSeverityFromActionCode('PACKING_HANG_DELETE'),
        snapshot: this.buildPackingHangSnapshot(packingHang),
        message: renderAuditMessage('PACKING_HANG_DELETE', {
          packingCode: packingHang.code,
        }),
        messageTemplate: 'PACKING_HANG_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingHang.branchId || undefined,
      });
    }

    return { message: 'Xóa phiếu treo hàng thành công' };
  }

  private async generateCode(tx: any): Promise<string> {
    const lastPackingHang = await tx.packingHang.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastPackingHang) {
      const match = lastPackingHang.code.match(/DDH(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `DDH${nextNumber.toString().padStart(6, '0')}`;
  }

  private buildPackingHangSnapshot(ph: any) {
    return {
      code: ph.code,
      branchId: ph.branchId,
      branchName: ph.branch?.name,
      numberOfPackages: ph.numberOfPackages,
      note: ph.note,
      invoices: (ph.invoices || []).map((i: any) => ({
        invoiceId: i.invoiceId,
        invoiceCode: i.invoice?.code,
      })),
    };
  }
}
