import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addCustomerChangedHook } from '../common/customer-debt.util';
import {
  computeCustomerAging,
  type AgingInvoiceInput,
  type DebtPolicyInput,
} from './debt-aging.util';
import {
  DEBT_TRACKING_CYCLE_CLOSE_MODE,
  DEBT_TRACKING_CYCLE_STATUS,
  INVOICE_STATUS_CANCELLED,
  MONEY_EPSILON,
} from './debt-tracking.constants';

type DbClient = PrismaService | Prisma.TransactionClient;

export interface DebtCycleSnapshotAttempt {
  id: number;
  role: 'ACCOUNTANT' | 'SALES';
  attemptDate: string;
  recordedAt: string;
  recordedBy: { id: number; name: string };
}

export interface DebtCycleSnapshotTicket {
  ticketId: number;
  ticketCode: string;
  ticketType: string;
  ticketStatus: string;
  createdAt: string;
}

export interface DebtCycleSnapshot {
  note: string | null;
  noteAt: string | null;
  noteBy: number | null;
  accountantAttempts: DebtCycleSnapshotAttempt[];
  salesAttempts: DebtCycleSnapshotAttempt[];
  tickets: DebtCycleSnapshotTicket[];
  requiredPaymentAmount: number;
  requiredPaymentSource: string;
  totalDebt: number;
  overdueAmount: number;
  debtStatus: string;
}

@Injectable()
export class DebtTrackingCycleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DebtTrackingCycleService.name);
  private readonly AUTO_CLOSE_DEBOUNCE_MS = 3000;
  private readonly pendingTimers = new Map<number, NodeJS.Timeout>();
  private unregisterHook: (() => void) | null = null;

  constructor(private prisma: PrismaService) {}

  onModuleInit(): void {
    this.unregisterHook = addCustomerChangedHook((customerId) =>
      this.enqueueAutoClose(customerId),
    );
  }

  onModuleDestroy(): void {
    this.unregisterHook?.();
    this.unregisterHook = null;
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  async getSummaries(customerIds: number[]) {
    if (customerIds.length === 0) {
      return new Map<
        number,
        {
          currentCycle: {
            id: number;
            startedAt: Date;
            requiredPaymentAtStart: number;
          } | null;
          closedCycleCount: number;
        }
      >();
    }
    const rows = await this.prisma.customerDebtTrackingCycle.findMany({
      where: { customerId: { in: customerIds } },
      select: {
        id: true,
        customerId: true,
        status: true,
        startedAt: true,
        requiredPaymentAtStart: true,
      },
    });
    const map = new Map<
      number,
      {
        currentCycle: {
          id: number;
          startedAt: Date;
          requiredPaymentAtStart: number;
        } | null;
        closedCycleCount: number;
      }
    >();
    for (const id of customerIds) {
      map.set(id, { currentCycle: null, closedCycleCount: 0 });
    }
    for (const row of rows) {
      const current = map.get(row.customerId) ?? {
        currentCycle: null,
        closedCycleCount: 0,
      };
      if (row.status === DEBT_TRACKING_CYCLE_STATUS.OPEN) {
        current.currentCycle = {
          id: row.id,
          startedAt: row.startedAt,
          requiredPaymentAtStart: Number(row.requiredPaymentAtStart),
        };
      } else {
        current.closedCycleCount += 1;
      }
      map.set(row.customerId, current);
    }
    return map;
  }

  async getOpenCycleIds(customerIds: number[]): Promise<Map<number, number>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.prisma.customerDebtTrackingCycle.findMany({
      where: {
        customerId: { in: customerIds },
        status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
      },
      select: { id: true, customerId: true },
    });
    return new Map(rows.map((row) => [row.customerId, row.id]));
  }

  async getLastClosedAtMap(customerIds: number[]): Promise<Map<number, Date>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.prisma.customerDebtTrackingCycle.findMany({
      where: {
        customerId: { in: customerIds },
        status: DEBT_TRACKING_CYCLE_STATUS.CLOSED,
        closedAt: { not: null },
      },
      select: { customerId: true, closedAt: true },
      orderBy: { closedAt: 'desc' },
    });
    const map = new Map<number, Date>();
    for (const row of rows) {
      if (row.closedAt && !map.has(row.customerId)) {
        map.set(row.customerId, row.closedAt);
      }
    }
    return map;
  }

  currentAttemptWhere(
    customerId: number,
    lastClosedAt?: Date | null,
  ): Prisma.CustomerDebtCollectionAttemptWhereInput {
    return {
      customerId,
      ...(lastClosedAt ? { recordedAt: { gt: lastClosedAt } } : {}),
    };
  }

  isInCurrentCycle(at: Date, lastClosedAt?: Date | null) {
    return !lastClosedAt || at.getTime() > lastClosedAt.getTime();
  }

  async ensureOpenCycle(customerId: number, db: DbClient = this.prisma) {
    const existing = await db.customerDebtTrackingCycle.findFirst({
      where: {
        customerId,
        status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
      },
    });
    const aging = await this.computeAging(customerId, db);
    if (existing) {
      const nextRequired = aging?.requiredPaymentAmount ?? 0;
      if (nextRequired > Number(existing.requiredPaymentAtStart) + MONEY_EPSILON) {
        return db.customerDebtTrackingCycle.update({
          where: { id: existing.id },
          data: { requiredPaymentAtStart: nextRequired },
        });
      }
      return existing;
    }

    return db.customerDebtTrackingCycle.create({
      data: {
        customerId,
        status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
        requiredPaymentAtStart: aging?.requiredPaymentAmount ?? 0,
        totalDebtAtStart: aging?.totalDebt ?? 0,
      },
    });
  }

  async closeCurrentCycle(
    customerId: number,
    opts: {
      mode: 'MANUAL' | 'AUTO_PAYMENT';
      userId?: number | null;
      requireData?: boolean;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`;
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          name: true,
          debtNote: true,
        },
      });
      if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

      const openCycle = await tx.customerDebtTrackingCycle.findFirst({
        where: {
          customerId,
          status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
        },
      });
      const previousClosed = await tx.customerDebtTrackingCycle.findFirst({
        where: {
          customerId,
          status: DEBT_TRACKING_CYCLE_STATUS.CLOSED,
          closedAt: { not: null },
        },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      });
      const lastClosedAt = previousClosed?.closedAt ?? null;
      const attempts = await tx.customerDebtCollectionAttempt.findMany({
        where: this.currentAttemptWhere(customerId, lastClosedAt),
        include: { recordedBy: { select: { id: true, name: true } } },
        orderBy: [{ role: 'asc' }, { attemptDate: 'asc' }],
      });
      const ticketLines = await tx.debtTicketCustomer.findMany({
        where: {
          customerId,
          ...(lastClosedAt ? { createdAt: { gt: lastClosedAt } } : {}),
        },
        include: {
          ticket: {
            select: {
              id: true,
              code: true,
              status: true,
              ticketType: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      const note = customer.debtNote?.note?.trim() || null;
      const hasData =
        attempts.some((row) => row.isActive) || !!note || ticketLines.length > 0;
      if (opts.requireData !== false && !hasData) {
        throw new BadRequestException(
          'Chưa có lần đòi nợ hoặc ghi chú để lưu vào chu kỳ.',
        );
      }
      if (!hasData && !openCycle) {
        return null;
      }

      const aging = await this.computeAging(customerId, tx);
      const activeAttempts = attempts.filter((row) => row.isActive);
      const snapshot: DebtCycleSnapshot = {
        note,
        noteAt: customer.debtNote?.noteAt?.toISOString() ?? null,
        noteBy: customer.debtNote?.noteBy ?? null,
        accountantAttempts: activeAttempts
          .filter((row) => row.role === 'ACCOUNTANT')
          .map((row) => this.serializeAttempt(row)),
        salesAttempts: activeAttempts
          .filter((row) => row.role === 'SALES')
          .map((row) => this.serializeAttempt(row)),
        tickets: ticketLines.map((line) => ({
          ticketId: line.ticket.id,
          ticketCode: line.ticket.code,
          ticketType: line.ticket.ticketType,
          ticketStatus: line.ticket.status,
          createdAt: line.ticket.createdAt.toISOString(),
        })),
        requiredPaymentAmount: aging?.requiredPaymentAmount ?? 0,
        requiredPaymentSource: aging?.requiredPaymentSource ?? 'NONE',
        totalDebt: aging?.totalDebt ?? 0,
        overdueAmount: aging?.overdueAmount ?? 0,
        debtStatus: aging?.debtStatus ?? 'NORMAL',
      };

      const closed =
        openCycle ??
        (await tx.customerDebtTrackingCycle.create({
          data: {
            customerId,
            status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
            requiredPaymentAtStart: snapshot.requiredPaymentAmount,
            totalDebtAtStart: snapshot.totalDebt,
          },
        }));

      const updated = await tx.customerDebtTrackingCycle.update({
        where: { id: closed.id },
        data: {
          status: DEBT_TRACKING_CYCLE_STATUS.CLOSED,
          closedAt: new Date(),
          closedById: opts.userId ?? null,
          closeMode: opts.mode,
          requiredPaymentAtClose: snapshot.requiredPaymentAmount,
          totalDebtAtClose: snapshot.totalDebt,
          note: snapshot.note,
          noteAt: customer.debtNote?.noteAt ?? null,
          noteBy: customer.debtNote?.noteBy ?? null,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });

      if (attempts.length > 0) {
        await tx.customerDebtCollectionAttempt.updateMany({
          where: { id: { in: attempts.map((row) => row.id) } },
          data: { cycleId: updated.id },
        });
      }

      if (customer.debtNote) {
        await tx.customerDebtNote.update({
          where: { customerId },
          data: { note: null, noteAt: null, noteBy: null },
        });
      }

      return updated;
    });
  }

  async listCycles(customerId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, code: true },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    const rows = await this.prisma.customerDebtTrackingCycle.findMany({
      where: {
        customerId,
        status: DEBT_TRACKING_CYCLE_STATUS.CLOSED,
      },
      orderBy: { closedAt: 'desc' },
      include: {
        closedBy: { select: { id: true, name: true } },
      },
    });

    return {
      customer,
      data: rows.map((row) => this.serializeCycle(row)),
    };
  }

  async maybeAutoClose(customerId: number) {
    const open = await this.prisma.customerDebtTrackingCycle.findFirst({
      where: {
        customerId,
        status: DEBT_TRACKING_CYCLE_STATUS.OPEN,
      },
    });
    if (!open) return null;
    if (Number(open.requiredPaymentAtStart) <= MONEY_EPSILON) return null;

    const aging = await this.computeAging(customerId);
    if (!aging || aging.requiredPaymentAmount > MONEY_EPSILON) return null;

    try {
      return await this.closeCurrentCycle(customerId, {
        mode: DEBT_TRACKING_CYCLE_CLOSE_MODE.AUTO_PAYMENT,
        userId: null,
        requireData: false,
      });
    } catch (error) {
      this.logger.warn(
        `Auto-close cycle failed for customer ${customerId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return null;
    }
  }

  private enqueueAutoClose(customerId: number) {
    const existing = this.pendingTimers.get(customerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(customerId);
      void this.maybeAutoClose(customerId);
    }, this.AUTO_CLOSE_DEBOUNCE_MS);
    this.pendingTimers.set(customerId, timer);
  }

  private serializeCycle(row: {
    id: number;
    customerId: number;
    status: string;
    startedAt: Date;
    closedAt: Date | null;
    closeMode: string | null;
    requiredPaymentAtStart: unknown;
    requiredPaymentAtClose: unknown;
    totalDebtAtStart: unknown;
    totalDebtAtClose: unknown;
    note: string | null;
    noteAt: Date | null;
    snapshot: Prisma.JsonValue | null;
    closedBy: { id: number; name: string } | null;
  }) {
    return {
      id: row.id,
      customerId: row.customerId,
      status: row.status,
      startedAt: row.startedAt,
      closedAt: row.closedAt,
      closeMode: row.closeMode,
      requiredPaymentAtStart: Number(row.requiredPaymentAtStart),
      requiredPaymentAtClose:
        row.requiredPaymentAtClose == null
          ? null
          : Number(row.requiredPaymentAtClose),
      totalDebtAtStart: Number(row.totalDebtAtStart),
      totalDebtAtClose:
        row.totalDebtAtClose == null ? null : Number(row.totalDebtAtClose),
      note: row.note,
      noteAt: row.noteAt,
      snapshot: (row.snapshot as DebtCycleSnapshot | null) ?? null,
      closedBy: row.closedBy,
    };
  }

  private serializeAttempt(row: {
    id: number;
    role: string;
    attemptDate: Date;
    recordedAt: Date;
    recordedBy: { id: number; name: string };
  }): DebtCycleSnapshotAttempt {
    return {
      id: row.id,
      role: row.role as 'ACCOUNTANT' | 'SALES',
      attemptDate: this.formatDateOnly(row.attemptDate),
      recordedAt: row.recordedAt.toISOString(),
      recordedBy: row.recordedBy,
    };
  }

  private formatDateOnly(value: Date): string {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }

  private toPolicyInput(policy: {
    debtRuleType?: string | null;
    paymentScheduleType?: string | null;
    paymentScheduleDays?: unknown;
    hasCreditLimit: boolean;
    creditLimit: unknown;
    hasTermDays: boolean;
    termDays: number | null;
    paymentFrequency: number | null;
  } | null): DebtPolicyInput {
    if (!policy) return { hasCreditLimit: false, hasTermDays: false };
    const rule = policy.debtRuleType;
    const hasCreditLimit = rule
      ? rule === 'CREDIT_LIMIT'
      : !!policy.hasCreditLimit;
    const hasTermDays = rule ? rule === 'TERM_DAYS' : !!policy.hasTermDays;
    return {
      debtRuleType: rule,
      hasCreditLimit,
      creditLimit:
        policy.creditLimit !== null && policy.creditLimit !== undefined
          ? Number(policy.creditLimit)
          : null,
      hasTermDays,
      termDays: hasTermDays ? policy.termDays : null,
      paymentFrequency: policy.paymentFrequency,
      paymentScheduleType:
        rule === 'MONTHLY_SCHEDULE' || rule === 'WEEKLY_SCHEDULE'
          ? (policy.paymentScheduleType as 'MONTHLY' | 'WEEKLY' | null)
          : null,
      paymentScheduleDays:
        rule === 'MONTHLY_SCHEDULE' || rule === 'WEEKLY_SCHEDULE'
          ? Array.isArray(policy.paymentScheduleDays)
            ? policy.paymentScheduleDays.map(Number)
            : null
          : null,
    };
  }

  private async computeAging(customerId: number, db: DbClient = this.prisma) {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        totalDebt: true,
        debtPolicy: true,
      },
    });
    if (!customer) return null;
    const invoices = await db.invoice.findMany({
      where: {
        customerId,
        status: { notIn: [INVOICE_STATUS_CANCELLED] },
        grandTotal: { gt: 0 },
      },
      select: {
        id: true,
        code: true,
        grandTotal: true,
        deliveredAt: true,
        purchaseDate: true,
      },
      orderBy: { purchaseDate: 'desc' },
    });
    const agingInvoices: AgingInvoiceInput[] = invoices.map((inv) => ({
      id: inv.id,
      code: inv.code,
      grandTotal: Number(inv.grandTotal),
      deliveredAt: inv.deliveredAt,
      purchaseDate: inv.purchaseDate,
    }));
    return computeCustomerAging(
      Number(customer.totalDebt),
      agingInvoices,
      this.toPolicyInput(customer.debtPolicy),
      new Date(),
    );
  }
}
