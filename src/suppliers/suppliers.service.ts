import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';

@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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
              branch: {
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
              branch: {
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
        branch: {
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
        branch: {
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

  async create(
    dto: CreateSupplierDto,
    userId: number,
    branchId: number | null,
  ) {
    const { groupIds, ...supplierData } = dto;

    return this.prisma.$transaction(async (prisma) => {
      const code = await this.generateSafeSupplierCode(prisma);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
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
          createdName: user?.name || 'Unknown',
          branchId: branchId,
          groups: groupNames,
        },
        include: {
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          branch: {
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

      const finalSupplier = await prisma.supplier.findUnique({
        where: { id: supplier.id },
        include: {
          supplierGroupDetails: { include: { supplierGroup: true } },
          creator: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
          purchaseOrders: {
            orderBy: { purchaseDate: 'desc' },
            take: 10,
            include: { branch: true },
          },
        },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'SUPPLIER_CREATE',
        entityType: 'suppliers',
        entityId: supplier.id.toString(),
        entityCode: supplier.code || '',
        category: getCategoryFromActionCode('SUPPLIER_CREATE'),
        severity: getSeverityFromActionCode('SUPPLIER_CREATE'),
        snapshot: this.buildSupplierSnapshot(supplier),
        message: renderAuditMessage('SUPPLIER_CREATE', {
          supplierName: supplier.name,
          supplierCode: supplier.code,
        }),
        messageTemplate: 'SUPPLIER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });

      return finalSupplier;

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
          branch: {
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

  async update(id: number, dto: UpdateSupplierDto, userId?: number) {
    const existingSupplier = await this.prisma.supplier.findUnique({
      where: { id },
    });

    if (!existingSupplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    const { groupIds, ...supplierData } = dto;

    const result = await this.prisma.$transaction(async (prisma) => {
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

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const changes = buildChanges(
        'suppliers',
        {
          name: existingSupplier.name,
          contactNumber: existingSupplier.contactNumber,
          email: existingSupplier.email,
          address: existingSupplier.address,
          taxCode: existingSupplier.taxCode,
        },
        {
          name: result.name,
          contactNumber: result.contactNumber,
          email: result.email,
          address: result.address,
          taxCode: result.taxCode,
        },
      );

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'SUPPLIER_UPDATE',
        entityType: 'suppliers',
        entityId: id.toString(),
        entityCode: result.code || '',
        category: getCategoryFromActionCode('SUPPLIER_UPDATE'),
        severity: getSeverityFromActionCode('SUPPLIER_UPDATE'),
        snapshot: this.buildSupplierSnapshot(result),
        changes: changes.length > 0 ? changes : null,
        message: renderAuditMessage('SUPPLIER_UPDATE', {
          supplierName: result.name,
          supplierCode: result.code,
        }),
        messageTemplate: 'SUPPLIER_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return result;
  }

  async remove(id: number, userId?: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        _count: { select: { purchaseOrders: true } },
      },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${id} not found`);
    }

    if (supplier._count.purchaseOrders > 0) {
      throw new Error('Không thể xóa nhà cung cấp đã có phiếu nhập hàng');
    }

    await this.prisma.supplier.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'SUPPLIER_DELETE',
        entityType: 'suppliers',
        entityId: id.toString(),
        entityCode: supplier.code || '',
        category: getCategoryFromActionCode('SUPPLIER_DELETE'),
        severity: getSeverityFromActionCode('SUPPLIER_DELETE'),
        snapshot: this.buildSupplierSnapshot(supplier),
        message: renderAuditMessage('SUPPLIER_DELETE', {
          supplierName: supplier.name,
          supplierCode: supplier.code,
        }),
        messageTemplate: 'SUPPLIER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return { message: 'Xóa nhà cung cấp thành công' };
  }

  async updateDebt(supplierId: number) {
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: { supplierId },
    });

    const debt = purchaseOrders.reduce((sum, po) => {
      const poDebt =
        Number(po.total) - Number(po.discount) - Number(po.paidAmount);
      return sum + poDebt;
    }, 0);

    const totalInvoiced = purchaseOrders.reduce((sum, po) => {
      return sum + Number(po.total);
    }, 0);

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

  private buildSupplierSnapshot(supplier: any) {
    return {
      code: supplier.code,
      name: supplier.name,
      contactNumber: supplier.contactNumber,
      email: supplier.email,
      address: supplier.address,
      taxCode: supplier.taxCode,
      groups: supplier.groups,
      debt: supplier.debt ? Number(supplier.debt) : 0,
      totalInvoiced: supplier.totalInvoiced
        ? Number(supplier.totalInvoiced)
        : 0,
      branch: supplier.branch ? { name: supplier.branch.name } : null,
      creator: supplier.creator ? { name: supplier.creator.name } : null,
    };
  }

  async getDebtTimeline(supplierId: number) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, debt: true },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with id ${supplierId} not found`);
    }

    const timeline: any[] = [];

    // 1. Lấy purchase orders → cộng nợ
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: {
        supplierId,
        isDraft: false,
        status: { not: 2 },
        NOT: { code: { contains: '{DEL}' } },
      },
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        total: true,
        discount: true,
        subTotal: true,
        createdAt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { purchaseDate: 'asc' },
    });

    for (const po of purchaseOrders) {
      timeline.push({
        type: 'purchase',
        id: po.id,
        code: po.code,
        date: po.purchaseDate,
        createdAt: po.createdAt,
        amount: Number(po.subTotal),
        description: `Nhập hàng ${po.code}`,
        debtSnapshot: 0,
        branch: po.branch,
        user: po.creator,
      });
    }

    // 2. Lấy cashflows → trừ nợ (phiếu chi cho NCC)
    const cashFlows = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'S',
        partnerId: supplierId,
        isReceipt: false,
        status: { not: 2 },
      },
      select: {
        id: true,
        code: true,
        amount: true,
        transDate: true,
        method: true,
        description: true,
        createdAt: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { transDate: 'asc' },
    });

    for (const cf of cashFlows) {
      timeline.push({
        type: 'payment',
        id: cf.id,
        code: cf.code,
        date: cf.transDate,
        createdAt: cf.createdAt,
        amount: Number(cf.amount),
        method: cf.method,
        description: cf.description || `Thanh toán ${cf.code}`,
        debtSnapshot: 0,
        branch: cf.branch,
        user: cf.creator,
      });
    }

    // 3. Sort tăng dần theo ngày để tính zigzag
    const calcOrder: Record<string, number> = {
      purchase: 0,
      payment: 1,
    };

    timeline.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (calcOrder[a.type] ?? 0) - (calcOrder[b.type] ?? 0);
    });

    // 4. Tính debtSnapshot theo zigzag
    let runningDebt = 0;
    for (const item of timeline) {
      if (item.type === 'purchase') {
        runningDebt += item.amount;
      } else if (item.type === 'payment') {
        runningDebt -= item.amount;
      }
      item.debtSnapshot = runningDebt;
    }

    // 5. Sort giảm dần để hiển thị
    const typeOrder: Record<string, number> = {
      payment: 0,
      purchase: 1,
    };

    timeline.sort((a, b) => {
      const timeDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (typeOrder[a.type] ?? 1) - (typeOrder[b.type] ?? 1);
    });

    return { data: timeline };
  }
}
