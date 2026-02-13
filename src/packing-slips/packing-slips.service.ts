import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingSlipDto,
  UpdatePackingSlipDto,
  PackingSlipQueryDto,
} from './dto';

@Injectable()
export class PackingSlipsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: PackingSlipQueryDto) {
    const { branchId, search, pageSize = 15, currentItem = 0 } = query;

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
                  grandTotal: true,
                },
              },
            },
          },
          images: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: pageSize,
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
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

      const packingSlip = await tx.packingSlip.create({
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

      return packingSlip;
    });
  }

  async update(id: number, dto: UpdatePackingSlipDto) {
    const packingSlip = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
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
          create: dto.invoiceIds.map((invoiceId) => ({
            invoiceId,
          })),
        };
      }

      if (dto.imageUrls) {
        await tx.packingSlipImage.deleteMany({
          where: { packingSlipId: id },
        });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({
            imageUrl: url,
          })),
        };
      }

      const updated = await tx.packingSlip.update({
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

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.packingSlip.delete({
      where: { id },
    });
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
}
