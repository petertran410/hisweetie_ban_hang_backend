import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { searchCustomerIds } from '../../common/customer-search.util';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomerDemandRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findList(
    where: Record<string, unknown>,
    skip: number,
    take: number,
    orderBy: any[],
  ) {
    const delegate = this.delegate();
    return Promise.all([
      delegate.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          customer: { select: { id: true, code: true, name: true } },
          months: {
            orderBy: { demandMonth: 'asc' },
            include: {
              lines: {
                select: {
                  productId: true,
                  quantityBase: true,
                  sourceCreatedAt: true,
                },
              },
            },
          },
        },
      }),
      delegate.count({ where }),
    ]);
  }

  findById(id: number) {
    return this.delegate().findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, code: true, name: true } },
        months: {
          orderBy: { demandMonth: 'asc' },
          include: {
            lines: {
              orderBy: { id: 'asc' },
              include: {
                product: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    unit: true,
                    conversionValue: true,
                  },
                },
              },
            },
            changeLogs: {
              orderBy: { createdAt: 'desc' },
              include: {
                actor: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });
  }

  findMonthById(id: number) {
    return this.monthDelegate().findUnique({
      where: { id },
      include: {
        lines: { orderBy: { id: 'asc' } },
        demand: { select: { id: true, customerId: true, note: true } },
      },
    });
  }

  findPlanningMonths() {
    return this.monthDelegate().findMany({
      where: { status: 'CONFIRMED' },
      orderBy: { demandMonth: 'asc' },
      select: {
        id: true,
        demandMonth: true,
        status: true,
        demand: {
          select: { customerId: true, customer: { select: { name: true } } },
        },
        lines: {
          select: {
            productId: true,
            quantityBase: true,
            inputQuantity: true,
            inputUnit: true,
            conversionValue: true,
          },
        },
      },
    });
  }

  findSummaryMonths(where: Record<string, unknown>) {
    return this.monthDelegate().findMany({
      where,
      orderBy: { demandMonth: 'asc' },
      select: {
        id: true,
        demandId: true,
        demandMonth: true,
        demand: {
          select: {
            customerId: true,
            customer: { select: { id: true, code: true, name: true } },
          },
        },
        lines: {
          select: {
            id: true,
            inputQuantity: true,
            inputUnit: true,
            quantityBase: true,
            product: {
              select: { id: true, code: true, name: true, unit: true },
            },
          },
        },
      },
    });
  }

  findExportMonths(where: Record<string, unknown>) {
    return this.monthDelegate().findMany({
      where,
      orderBy: [{ demandMonth: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        demandId: true,
        demandMonth: true,
        status: true,
        note: true,
        demand: {
          select: {
            note: true,
            customer: { select: { id: true, code: true, name: true } },
          },
        },
        lines: {
          orderBy: { id: 'asc' },
          select: {
            inputQuantity: true,
            inputUnit: true,
            quantityBase: true,
            product: {
              select: { id: true, code: true, name: true, unit: true },
            },
          },
        },
      },
    });
  }

  searchCustomers(search?: string) {
    const value = search?.trim();
    const tokens = value ? value.split(/[\s·]+/).filter(Boolean) : [];
    return this.prisma.customer.findMany({
      where: value
        ? {
            isActive: true,
            AND: tokens.map((token) => ({
              OR: [
                { name: { contains: token, mode: 'insensitive' } },
                { code: { contains: token, mode: 'insensitive' } },
                { contactNumber: { contains: token, mode: 'insensitive' } },
              ],
            })),
          }
        : { isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  searchCustomerIds(search: string) {
    return searchCustomerIds(this.prisma, search);
  }

  findCustomer(id: number) {
    return this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, code: true, name: true },
    });
  }

  async findCustomersByCodes(codes: string[]) {
    const unique = [
      ...new Set(codes.map((code) => code.trim()).filter(Boolean)),
    ];
    if (!unique.length) return [];
    const rows: Array<{
      id: number;
      code: string | null;
      name: string;
      isActive: boolean;
    }> = [];
    for (let i = 0; i < unique.length; i += 50) {
      const part = unique.slice(i, i + 50);
      const found = await this.prisma.customer.findMany({
        where: {
          OR: part.map((code) => ({
            code: { equals: code, mode: 'insensitive' as const },
          })),
        },
        select: { id: true, code: true, name: true, isActive: true },
      });
      rows.push(...found);
    }
    return rows;
  }

  async findProductsByCodes(codes: string[]) {
    const unique = [
      ...new Set(codes.map((code) => code.trim()).filter(Boolean)),
    ];
    if (!unique.length) return [];
    const rows: Array<{
      id: number;
      code: string;
      name: string;
      unit: string | null;
      conversionValue: unknown;
      isActive: boolean;
    }> = [];
    for (let i = 0; i < unique.length; i += 50) {
      const part = unique.slice(i, i + 50);
      const found = await this.prisma.product.findMany({
        where: {
          OR: part.map((code) => ({
            code: { equals: code, mode: 'insensitive' as const },
          })),
        },
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          conversionValue: true,
          isActive: true,
        },
      });
      rows.push(...found);
    }
    return rows;
  }

  findProducts(ids: number[]) {
    return this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        name: true,
        unit: true,
        conversionValue: true,
      },
    });
  }

  async createConfirmed(data: {
    customerId: number;
    note?: string | null;
    createdBy: number;
    months: Array<{
      demandMonth: Date;
      lines: Array<{
        productId: number;
        inputQuantity: number;
        inputUnit: string;
        quantityBase: number;
        conversionValue: number;
      }>;
    }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const demand = await this.createConfirmedInTx(tx, data);
      return demand.id as number;
    });
  }

  async createManyConfirmed(
    items: Array<{
      customerId: number;
      note?: string | null;
      createdBy: number;
      months: Array<{
        demandMonth: Date;
        lines: Array<{
          productId: number;
          inputQuantity: number;
          inputUnit: string;
          quantityBase: number;
          conversionValue: number;
        }>;
      }>;
    }>,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const ids: number[] = [];
        for (const data of items) {
          const demand = await this.createConfirmedInTx(tx, data);
          ids.push(demand.id as number);
        }
        return ids;
      },
      { timeout: 120_000 },
    );
  }

  private async createConfirmedInTx(tx: any, data: {
    customerId: number;
    note?: string | null;
    createdBy: number;
    months: Array<{
      demandMonth: Date;
      lines: Array<{
        productId: number;
        inputQuantity: number;
        inputUnit: string;
        quantityBase: number;
        conversionValue: number;
      }>;
    }>;
  }) {
    return tx.customerDemand.create({
      data: {
        customerId: data.customerId,
        note: data.note ?? null,
        createdBy: data.createdBy,
        updatedBy: data.createdBy,
        months: {
          create: data.months.map((month) => ({
            demandMonth: month.demandMonth,
            status: 'CONFIRMED',
            lines: { create: month.lines },
          })),
        },
      },
    });
  }

  async updateDemand(
    demandId: number,
    data: {
      customerId?: number;
      note?: string | null;
      updatedBy: number;
      months: Array<{
        id?: number;
        demandMonth: Date;
        lines: Array<{
          productId: number;
          inputQuantity: number;
          inputUnit: string;
          quantityBase: number;
          conversionValue: number;
        }>;
        confirmedChange?: { reason: string; before: unknown };
      }>;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const demandDelegate = (tx as any).customerDemand;
      const monthDelegate = (tx as any).customerDemandMonth;
      const lineDelegate = (tx as any).customerDemandLine;
      const logDelegate = (tx as any).customerDemandChangeLog;
      const existing = await demandDelegate.findUnique({
        where: { id: demandId },
        include: { months: { include: { lines: true } } },
      });
      if (!existing) throw new NotFoundException('Không tìm thấy phiếu Demand');

      await demandDelegate.update({
        where: { id: demandId },
        data: {
          ...(data.customerId !== undefined
            ? { customerId: data.customerId }
            : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
          updatedBy: data.updatedBy,
        },
      });

      const incomingIds = new Set(
        data.months.map((month) => month.id).filter(Boolean),
      );
      for (const existingMonth of existing.months) {
        if (incomingIds.has(existingMonth.id)) continue;
        if (existingMonth.status !== 'DRAFT') continue;
        const linked = await (tx as any).customerDemandLarkRecord.count({
          where: {
            demandLineId: { in: existingMonth.lines.map((line: any) => line.id) },
          },
        });
        if (linked > 0) {
          throw new BadRequestException(
            'Tháng có dòng Lark; không thể xóa bằng API cập nhật phiếu',
          );
        }
        await monthDelegate.delete({ where: { id: existingMonth.id } });
      }

      for (const month of data.months) {
        if (!month.id) {
          await monthDelegate.create({
            data: {
              demandId,
              demandMonth: month.demandMonth,
              status: 'CONFIRMED',
              lines: { create: month.lines },
            },
          });
          continue;
        }

        const current = existing.months.find(
          (item: any) => item.id === month.id,
        );
        if (!current)
          throw new NotFoundException('Tháng Demand không thuộc phiếu này');
        const linked = await (tx as any).customerDemandLarkRecord.count({
          where: {
            demandLineId: { in: current.lines.map((line: any) => line.id) },
          },
        });
        if (linked > 0) {
          throw new BadRequestException(
            'Tháng có dòng Lark; hãy dùng chức năng sửa từng tháng để giữ liên kết đồng bộ',
          );
        }
        await lineDelegate.deleteMany({ where: { demandMonthId: current.id } });
        await monthDelegate.update({
          where: { id: current.id },
          data: {
            demandMonth: month.demandMonth,
            lines: { create: month.lines },
            ...(current.status === 'CONFIRMED' ? { status: 'CONFIRMED' } : {}),
          },
        });

        if (month.confirmedChange) {
          await logDelegate.create({
            data: {
              demandMonthId: current.id,
              action: 'EDIT',
              reason: month.confirmedChange.reason,
              beforeSnapshot: month.confirmedChange.before,
              afterSnapshot: {
                demandMonth: month.demandMonth,
                lines: month.lines,
              },
              actorId: data.updatedBy,
            },
          });
        }
      }

      return demandId;
    });
  }

  async updateMonth(
    monthId: number,
    data: {
      customerId?: number;
      demandMonth: Date;
      lines: Array<{
        id?: number;
        productId: number;
        inputQuantity: number;
        inputUnit: string;
        quantityBase: number;
        conversionValue: number;
      }>;
      note?: string | null;
      updatedBy: number;
      confirmedChange?: { reason: string; before: unknown };
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const demandDelegate = (tx as any).customerDemand;
      const monthDelegate = (tx as any).customerDemandMonth;
      const lineDelegate = (tx as any).customerDemandLine;
      const logDelegate = (tx as any).customerDemandChangeLog;
      const current = await monthDelegate.findUnique({
        where: { id: monthId },
        include: {
          demand: { select: { id: true, sourceSystem: true } },
          lines: true,
        },
      });
      if (!current) throw new NotFoundException('Không tìm thấy tháng Demand');

      const duplicateMonth = await monthDelegate.findFirst({
        where: {
          demandId: current.demandId,
          demandMonth: data.demandMonth,
          id: { not: monthId },
        },
        select: { id: true },
      });
      if (duplicateMonth) {
        throw new BadRequestException('Tháng đã tồn tại trong phiếu Demand');
      }

      await demandDelegate.update({
        where: { id: current.demandId },
        data: {
          updatedBy: data.updatedBy,
          ...(data.customerId !== undefined
            ? { customerId: data.customerId }
            : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
        },
      });

      const existingLines = new Map<number, any>(
        current.lines.map((line: any) => [line.id, line]),
      );
      const retainedIds = new Set<number>();
      for (const line of data.lines) {
        const { id, ...values } = line;
        if (id) {
          if (retainedIds.has(id) || !existingLines.has(id)) {
            throw new BadRequestException(
              'Dòng Demand không thuộc tháng này hoặc bị trùng',
            );
          }
          retainedIds.add(id);
          const existing = existingLines.get(id);
          if (
            existing.productId !== values.productId ||
            Number(existing.inputQuantity) !== values.inputQuantity ||
            existing.inputUnit !== values.inputUnit ||
            Number(existing.quantityBase) !== values.quantityBase ||
            Number(existing.conversionValue) !== values.conversionValue
          ) {
            await lineDelegate.update({ where: { id }, data: values });
          }
        } else {
          const created = await lineDelegate.create({
            data: { demandMonthId: monthId, ...values },
          });
          retainedIds.add(created.id);
        }
      }
      await lineDelegate.deleteMany({
        where: {
          demandMonthId: monthId,
          id: { notIn: [...retainedIds] },
        },
      });
      const updated = await monthDelegate.update({
        where: { id: monthId },
        data: { demandMonth: data.demandMonth },
      });

      if (data.confirmedChange) {
        await logDelegate.create({
          data: {
            demandMonthId: monthId,
            action: 'EDIT',
            reason: data.confirmedChange.reason,
            beforeSnapshot: data.confirmedChange.before,
            afterSnapshot: {
              demandMonth: data.demandMonth,
              lines: data.lines,
            },
            actorId: data.updatedBy,
          },
        });
      }

      if (current.demand.sourceSystem === 'LARK') {
        const dates = await (tx as any).customerDemandLine.aggregate({
          where: { demandMonth: { demandId: current.demandId } },
          _max: { sourceCreatedAt: true, sourceUpdatedAt: true },
        });
        if (dates._max.sourceCreatedAt && dates._max.sourceUpdatedAt) {
          await demandDelegate.update({
            where: { id: current.demandId },
            data: {
              createdAt: dates._max.sourceCreatedAt,
              updatedAt: dates._max.sourceUpdatedAt,
            },
          });
        }
      }

      return updated.id;
    });
  }

  async cancelMonth(monthId: number, userId: number, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const monthDelegate = (tx as any).customerDemandMonth;
      const logDelegate = (tx as any).customerDemandChangeLog;
      const current = await monthDelegate.findUnique({
        where: { id: monthId },
        include: { lines: true },
      });
      if (!current) throw new NotFoundException('Không tìm thấy tháng Demand');
      const updated = await monthDelegate.update({
        where: { id: monthId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
        },
        include: { lines: true },
      });
      await logDelegate.create({
        data: {
          demandMonthId: monthId,
          action: 'CANCEL',
          reason: reason?.trim() || 'Hủy nhu cầu khách hàng',
          beforeSnapshot: {
            status: current.status,
            lines: this.snapshotLines(current.lines),
          },
          afterSnapshot: {
            status: updated.status,
            lines: this.snapshotLines(updated.lines),
          },
          actorId: userId,
        },
      });
      return updated;
    });
  }

  private snapshotLines(lines: any[]) {
    return (lines ?? []).map((line: any) => ({
      productId: line.productId,
      inputQuantity: Number(line.inputQuantity),
      inputUnit: line.inputUnit,
      quantityBase: Number(line.quantityBase),
    }));
  }

  private delegate() {
    const delegate = (this.prisma as any).customerDemand;
    if (!delegate)
      throw new Error('Chưa sinh Prisma Client cho CustomerDemand');
    return delegate;
  }

  private monthDelegate() {
    const delegate = (this.prisma as any).customerDemandMonth;
    if (!delegate)
      throw new Error('Chưa sinh Prisma Client cho CustomerDemandMonth');
    return delegate;
  }
}
