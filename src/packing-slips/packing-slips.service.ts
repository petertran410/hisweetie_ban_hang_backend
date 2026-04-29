import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingSlipDto,
  UpdatePackingSlipDto,
  PackingSlipQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { INVOICE_STATUS, getStatusLabel } from 'src/invoices/dto';

@Injectable()
export class PackingSlipsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: PackingSlipQueryDto) {
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
      this.prisma.packingSlip.findMany({
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
      this.prisma.packingSlip.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const packingSlip = await this.prisma.packingSlip.findUnique({
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

    if (!packingSlip) {
      throw new NotFoundException(`Packing slip with ID ${id} not found`);
    }

    return packingSlip;
  }

  async create(dto: CreatePackingSlipDto, userId: number) {
    const packingSlip = await this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

      const created = await tx.packingSlip.create({
        data: {
          code,
          branchId: dto.branchId,
          numberOfPackages: dto.numberOfPackages,
          paymentMethod: dto.paymentMethod,
          cashAmount: dto.cashAmount || 0,
          hasFeeGuiBen: dto.hasFeeGuiBen,
          feeGuiBen: dto.feeGuiBen || 0,
          hasFeeGrab: dto.hasFeeGrab,
          feeGrab: dto.feeGrab || 0,
          hasCuocGuiHang: dto.hasCuocGuiHang,
          cuocGuiHang: dto.cuocGuiHang || 0,
          note: dto.note,
          createdBy: userId,
          invoices: {
            create: dto.invoiceIds.map((invoiceId) => ({ invoiceId })),
          },
          images: dto.imageUrls
            ? { create: dto.imageUrls.map((url) => ({ imageUrl: url })) }
            : undefined,
        },
        include: {
          branch: true,
          creator: true,
          invoices: { include: { invoice: true } },
          images: true,
        },
      });

      await tx.invoice.updateMany({
        where: {
          id: { in: dto.invoiceIds },
          status: {
            notIn: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.COMPLETED],
          },
        },
        data: {
          status: INVOICE_STATUS.DELIVERED,
          statusValue: getStatusLabel(INVOICE_STATUS.DELIVERED),
        },
      });

      return created;
    });

    // Audit log ngoài transaction
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'PACKING_SLIP_CREATE',
      entityType: 'packing_slips',
      entityId: packingSlip.id.toString(),
      entityCode: packingSlip.code,
      category: getCategoryFromActionCode('PACKING_SLIP_CREATE'),
      severity: getSeverityFromActionCode('PACKING_SLIP_CREATE'),
      snapshot: this.buildPackingSlipSnapshot(packingSlip),
      message: renderAuditMessage('PACKING_SLIP_CREATE', {
        packingCode: packingSlip.code,
      }),
      messageTemplate: 'PACKING_SLIP_CREATE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: packingSlip.branchId || undefined,
    });

    return packingSlip;
  }

  async update(id: number, dto: UpdatePackingSlipDto, userId?: number) {
    const packingSlip = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updateData: any = {
        branchId: dto.branchId,
        numberOfPackages: dto.numberOfPackages,
        paymentMethod: dto.paymentMethod,
        cashAmount: dto.cashAmount || 0,
        hasFeeGuiBen: dto.hasFeeGuiBen,
        feeGuiBen: dto.feeGuiBen || 0,
        hasFeeGrab: dto.hasFeeGrab,
        feeGrab: dto.feeGrab || 0,
        hasCuocGuiHang: dto.hasCuocGuiHang,
        cuocGuiHang: dto.cuocGuiHang || 0,
        note: dto.note,
      };

      if (dto.invoiceIds) {
        await tx.packingSlipInvoice.deleteMany({
          where: { packingSlipId: id },
        });
        updateData.invoices = {
          create: dto.invoiceIds.map((invoiceId) => ({ invoiceId })),
        };
      }

      if (dto.imageUrls) {
        await tx.packingSlipImage.deleteMany({ where: { packingSlipId: id } });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({ imageUrl: url })),
        };
      }

      return tx.packingSlip.update({
        where: { id },
        data: updateData,
        include: {
          branch: true,
          creator: true,
          invoices: { include: { invoice: true } },
          images: true,
        },
      });
    });

    // Audit log ngoài transaction
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'PACKING_SLIP_UPDATE',
        entityType: 'packing_slips',
        entityId: id.toString(),
        entityCode: packingSlip.code,
        category: getCategoryFromActionCode('PACKING_SLIP_CREATE'),
        severity: getSeverityFromActionCode('PACKING_SLIP_CREATE'),
        snapshot: this.buildPackingSlipSnapshot(updated),
        message: `Cập nhật phiếu đóng hàng ${packingSlip.code}`,
        messageTemplate: 'PACKING_SLIP_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingSlip.branchId || undefined,
      });
    }

    return updated;
  }

  async remove(id: number, userId?: number) {
    const packingSlip = await this.findOne(id);

    await this.prisma.packingSlip.delete({
      where: { id },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PACKING_SLIP_DELETE',
        entityType: 'packing_slips',
        entityId: id.toString(),
        entityCode: packingSlip.code,
        category: getCategoryFromActionCode('PACKING_SLIP_DELETE'),
        severity: getSeverityFromActionCode('PACKING_SLIP_DELETE'),
        snapshot: this.buildPackingSlipSnapshot(packingSlip),
        message: renderAuditMessage('PACKING_SLIP_DELETE', {
          packingCode: packingSlip.code,
        }),
        messageTemplate: 'PACKING_SLIP_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingSlip.branchId || undefined,
      });
    }

    return { message: 'Xóa phiếu giao hàng thành công' };
  }

  private async generateCode(tx: any): Promise<string> {
    const lastPackingSlip = await tx.packingSlip.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastPackingSlip) {
      const match = lastPackingSlip.code.match(/BD(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `BD${nextNumber.toString().padStart(6, '0')}`;
  }

  private buildPackingSlipSnapshot(ps: any) {
    return {
      code: ps.code,
      branchId: ps.branchId,
      branchName: ps.branch?.name,
      numberOfPackages: ps.numberOfPackages,
      paymentMethod: ps.paymentMethod,
      cashAmount: Number(ps.cashAmount || 0),
      feeGuiBen: Number(ps.feeGuiBen || 0),
      feeGrab: Number(ps.feeGrab || 0),
      cuocGuiHang: Number(ps.cuocGuiHang || 0),
      note: ps.note,
      invoices: (ps.invoices || []).map((i: any) => ({
        invoiceId: i.invoiceId,
        invoiceCode: i.invoice?.code,
      })),
    };
  }

  async checkInvoices(
    invoiceIds: number[],
  ): Promise<{ invoiceId: number; code: string }[]> {
    if (!invoiceIds.length) return [];

    const records = await this.prisma.packingSlipInvoice.findMany({
      where: { invoiceId: { in: invoiceIds } },
      include: { packingSlip: { select: { code: true } } },
    });

    return records.map((r) => ({
      invoiceId: r.invoiceId,
      code: r.packingSlip.code,
    }));
  }
}
