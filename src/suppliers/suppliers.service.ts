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
      where.debt = {};
      if (debtFrom !== undefined) {
        where.debt.gte = debtFrom;
      }
      if (debtTo !== undefined) {
        where.debt.lte = debtTo;
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
              creator: {
                select: {
                  id: true,
                  name: true,
                },
              },
            }
          : {
              creator: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
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
        creator: {
          select: {
            id: true,
            name: true,
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
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with code ${code} not found`);
    }

    return supplier;
  }

  async create(dto: CreateSupplierDto, userId: number) {
    const { groupIds, ...supplierData } = dto;

    return this.prisma.$transaction(async (prisma) => {
      const code = await this.generateSafeSupplierCode(prisma);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      const groupNames =
        groupIds && groupIds.length > 0
          ? await prisma.supplierGroup
              .findMany({
                where: { id: { in: groupIds } },
                select: { name: true },
              })
              .then((groups) => groups.map((g) => g.name).join('|'))
          : null;

      const supplier = await prisma.supplier.create({
        data: {
          ...supplierData,
          code,
          createdBy: userId,
          createdName: user?.name || '',
          groups: groupNames,
        },
        include: {
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
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

      return prisma.supplier.findUnique({
        where: { id: supplier.id },
        include: {
          supplierGroupDetails: {
            include: {
              supplierGroup: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
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
      const groupNames =
        groupIds !== undefined && groupIds.length > 0
          ? await prisma.supplierGroup
              .findMany({
                where: { id: { in: groupIds } },
                select: { name: true },
              })
              .then((groups) => groups.map((g) => g.name).join('|'))
          : null;

      const updated = await prisma.supplier.update({
        where: { id },
        data: {
          ...supplierData,
          groups: groupNames,
        },
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

    const debt = purchaseOrders.reduce(
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
        debt,
        totalInvoiced,
      },
    });
  }

  private async generateSafeSupplierCode(tx: any): Promise<string> {
    const prefix = 'NCC';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allSuppliers = await tx.supplier.findMany({
        where: {
          code: { startsWith: prefix },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allSuppliers
        .map((sup: any) => sup.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
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

      const exists = await tx.supplier.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã nhà cung cấp duy nhất');
  }
}
