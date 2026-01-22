import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: SupplierQueryDto) {
    const {
      code,
      name,
      contactNumber,
      pageSize = 15,
      currentItem = 0,
      orderBy = 'createdAt',
      orderDirection = 'desc',
      groupId,
      branchId,
      createdDateFrom,
      createdDateTo,
      totalInvoicedFrom,
      totalInvoicedTo,
      debtFrom,
      debtTo,
      isActive,
      includeSupplierGroup,
    } = query;

    const where: Prisma.SupplierWhereInput = {};

    if (code) {
      where.code = { contains: code, mode: 'insensitive' };
    }

    if (name) {
      where.name = { contains: name, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.OR = [
        { contactNumber: { contains: contactNumber, mode: 'insensitive' } },
        { phone: { contains: contactNumber, mode: 'insensitive' } },
      ];
    }

    if (groupId) {
      where.supplierGroupDetails = {
        some: {
          supplierGroupId: groupId,
        },
      };
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        where.createdAt.lte = new Date(createdDateTo);
      }
    }

    if (totalInvoicedFrom !== undefined || totalInvoicedTo !== undefined) {
      where.totalInvoiced = {};
      if (totalInvoicedFrom !== undefined) {
        where.totalInvoiced.gte = totalInvoicedFrom;
      }
      if (totalInvoicedTo !== undefined) {
        where.totalInvoiced.lte = totalInvoicedTo;
      }
    }

    if (debtFrom !== undefined || debtTo !== undefined) {
      where.totalDebt = {};
      if (debtFrom !== undefined) {
        where.totalDebt.gte = debtFrom;
      }
      if (debtTo !== undefined) {
        where.totalDebt.lte = debtTo;
      }
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { [orderBy]: orderDirection },
        include: includeSupplierGroup
          ? {
              supplierGroupDetails: {
                include: {
                  supplierGroup: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            }
          : undefined,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  async findOne(id: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        supplierGroupDetails: {
          include: {
            supplierGroup: true,
          },
        },
        purchaseOrders: {
          orderBy: { purchaseDate: 'desc' },
          take: 10,
          include: {
            branch: true,
          },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    return supplier;
  }

  async findByCode(code: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { code },
      include: {
        supplierGroupDetails: {
          include: {
            supplierGroup: true,
          },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with code ${code} not found`);
    }

    return supplier;
  }

  async create(dto: CreateSupplierDto) {
    const code = dto.code || (await this.generateCode());
    const { groupIds, ...supplierData } = dto;

    return this.prisma.$transaction(async (prisma) => {
      const supplier = await prisma.supplier.create({
        data: {
          ...supplierData,
          code,
        },
      });

      if (groupIds && groupIds.length > 0) {
        await prisma.supplierGroupDetail.createMany({
          data: groupIds.map((groupId) => ({
            supplierId: supplier.id,
            supplierGroupId: groupId,
          })),
          skipDuplicates: true,
        });
      }

      return this.findOne(supplier.id);
    });
  }

  async update(id: number, dto: UpdateSupplierDto) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    const { groupIds, ...supplierData } = dto;

    return this.prisma.$transaction(async (prisma) => {
      const updated = await prisma.supplier.update({
        where: { id },
        data: supplierData,
      });

      if (groupIds !== undefined) {
        await prisma.supplierGroupDetail.deleteMany({
          where: { supplierId: id },
        });

        if (groupIds.length > 0) {
          await prisma.supplierGroupDetail.createMany({
            data: groupIds.map((groupId) => ({
              supplierId: id,
              supplierGroupId: groupId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return this.findOne(updated.id);
    });
  }

  async remove(id: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        _count: {
          select: { purchaseOrders: true },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    if (supplier._count.purchaseOrders > 0) {
      throw new Error('Không thể xóa nhà cung cấp đã có phiếu nhập hàng');
    }

    await this.prisma.supplier.delete({ where: { id } });

    return { message: 'Xóa nhà cung cấp thành công' };
  }

  async updateDebt(supplierId: number) {
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: { supplierId },
    });

    const totalDebt = purchaseOrders.reduce(
      (sum, po) => sum + Number(po.debtAmount),
      0,
    );

    const totalInvoiced = purchaseOrders.reduce(
      (sum, po) => sum + Number(po.grandTotal),
      0,
    );

    return this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        totalDebt,
        totalInvoiced,
      },
    });
  }

  private async generateCode(): Promise<string> {
    const count = await this.prisma.supplier.count();
    return `NCC${String(count + 1).padStart(6, '0')}`;
  }
}
