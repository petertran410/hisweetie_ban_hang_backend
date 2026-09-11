export type CustomerDemandStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
export type CustomerDemandUnit = 'BASE' | 'CARTON';
export type CustomerDemandSkipReason = 'INBOUND_BETWEEN';

export interface CustomerDemandLineInput {
  productId: number;
  quantityBase: number;
  inputQuantity?: number;
  inputUnit?: CustomerDemandUnit | string;
  conversionValue?: number;
  createdAt?: Date | string | null;
}

export interface CustomerDemandMonthInput {
  id?: number;
  demandMonth: Date | string;
  status: CustomerDemandStatus | string;
  customerId?: number;
  customerName?: string | null;
  createdAt?: Date | string | null;
  demandCreatedAt?: Date | string | null;
  lines: CustomerDemandLineInput[];
}

export interface InboundOrderEvent {
  productId: number;
  orderDate: Date | string;
  status?: number | string | null;
}

export interface CustomerDemandDetail {
  monthId: number | null;
  customerId: number | null;
  customerName: string | null;
  demandMonth: string;
  quantityBase: number;
  skipped?: boolean;
  skipReason?: CustomerDemandSkipReason | null;
}

export interface ResolvedCustomerDemand {
  totalByProduct: Map<number, number>;
  detailsByProduct: Map<number, CustomerDemandDetail[]>;
  includedMonths: string[];
}

const QUALIFYING_INBOUND_STATUSES = new Set([1, 2, 3]);

/**
 * Chọn Demand OEM được phép đưa vào một lần tính Purchasing Planning.
 *
 * Chỉ tháng CONFIRMED, từ tháng hiện tại trở đi và bắt đầu trong planning
 * horizon mới được tính. Demand tháng đã qua chỉ còn để tra cứu lịch sử.
 * Demand trùng cùng khách/SKU/tháng được gộp theo đơn đặt hàng nhập xen giữa.
 */
export function resolveCustomerDemand(
  months: CustomerDemandMonthInput[],
  snapshotDate: Date | string,
  horizonDays: number,
  inboundOrders: InboundOrderEvent[] = [],
): ResolvedCustomerDemand {
  const snapshot = toDate(snapshotDate);
  const currentMonthStart = startOfMonth(snapshot);
  const horizonEnd = new Date(
    snapshot.getTime() + Math.max(0, horizonDays) * 86_400_000,
  );
  return accumulateConfirmedDemand(
    months,
    (demandMonth) =>
      demandMonth >= currentMonthStart && demandMonth <= horizonEnd,
    inboundOrders,
  );
}

/**
 * Demand OEM Confirmed của các tháng lịch đã kết thúc, dùng để trừ khỏi
 * tổng nhu cầu SOQ. Mặc định lấy 3 tháng ngay trước tháng snapshot.
 */
export function resolvePastCustomerDemand(
  months: CustomerDemandMonthInput[],
  snapshotDate: Date | string,
  completedMonths = 3,
  inboundOrders: InboundOrderEvent[] = [],
): ResolvedCustomerDemand {
  const snapshot = toDate(snapshotDate);
  const currentMonthStart = startOfMonth(snapshot);
  const lookback = Math.max(0, completedMonths);
  const windowStart = new Date(
    Date.UTC(
      currentMonthStart.getUTCFullYear(),
      currentMonthStart.getUTCMonth() - lookback,
      1,
    ),
  );
  return accumulateConfirmedDemand(
    months,
    (demandMonth) =>
      demandMonth >= windowStart && demandMonth < currentMonthStart,
    inboundOrders,
  );
}

function accumulateConfirmedDemand(
  months: CustomerDemandMonthInput[],
  includeMonth: (demandMonth: Date) => boolean,
  inboundOrders: InboundOrderEvent[],
): ResolvedCustomerDemand {
  const events: DemandEvent[] = [];

  for (const month of months ?? []) {
    if (String(month.status).toUpperCase() !== 'CONFIRMED') continue;
    const demandMonth = startOfMonth(toDate(month.demandMonth));
    if (!includeMonth(demandMonth)) continue;

    const monthKey = dateKey(demandMonth).slice(0, 7);
    for (const line of month.lines ?? []) {
      const productId = Number(line.productId);
      const quantityBase = Number(line.quantityBase);
      if (!Number.isInteger(productId) || productId <= 0) continue;
      if (!Number.isFinite(quantityBase) || quantityBase <= 0) continue;
      events.push({
        monthId: month.id ?? null,
        customerId: month.customerId ?? null,
        customerName: month.customerName ?? null,
        productId,
        demandMonth: monthKey,
        quantityBase,
        createdAt: eventTime(line.createdAt, month.createdAt, month.demandCreatedAt),
      });
    }
  }

  const { kept, skipped } = collapseOverlappingDemand(events, inboundOrders);
  const totalByProduct = new Map<number, number>();
  const detailsByProduct = new Map<number, CustomerDemandDetail[]>();
  const includedMonths = new Set<string>();

  for (const event of kept) {
    totalByProduct.set(
      event.productId,
      (totalByProduct.get(event.productId) ?? 0) + event.quantityBase,
    );
    includedMonths.add(event.demandMonth);
    pushDetail(detailsByProduct, event, false);
  }
  for (const event of skipped) {
    pushDetail(detailsByProduct, event, true);
  }
  for (const [productId, details] of detailsByProduct) {
    detailsByProduct.set(productId, sortDetails(details));
  }

  return {
    totalByProduct,
    detailsByProduct,
    includedMonths: [...includedMonths].sort(),
  };
}

interface DemandEvent {
  monthId: number | null;
  customerId: number | null;
  customerName: string | null;
  productId: number;
  demandMonth: string;
  quantityBase: number;
  createdAt: number;
}

function collapseOverlappingDemand(
  events: DemandEvent[],
  inboundOrders: InboundOrderEvent[],
): { kept: DemandEvent[]; skipped: DemandEvent[] } {
  const inboundByProduct = inboundTimesByProduct(inboundOrders);
  const groups = new Map<string, DemandEvent[]>();
  for (const event of events) {
    const key = `${event.customerId ?? 0}:${event.productId}:${event.demandMonth}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }

  const kept: DemandEvent[] = [];
  const skipped: DemandEvent[] = [];
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        a.createdAt - b.createdAt || (a.monthId ?? 0) - (b.monthId ?? 0),
    );
    const times = inboundByProduct.get(list[0].productId) ?? [];
    for (let index = 0; index < list.length; index += 1) {
      const isLast = index === list.length - 1;
      if (
        !isLast &&
        hasInboundBetween(times, list[index].createdAt, list[index + 1].createdAt)
      ) {
        skipped.push(list[index]);
        continue;
      }
      kept.push(list[index]);
    }
  }
  return { kept, skipped };
}

function inboundTimesByProduct(
  inboundOrders: InboundOrderEvent[],
): Map<number, number[]> {
  const times = new Map<number, number[]>();
  for (const order of inboundOrders ?? []) {
    if (!isQualifyingInboundStatus(order.status)) continue;
    const productId = Number(order.productId);
    const at = toDateTime(order.orderDate);
    if (!Number.isInteger(productId) || productId <= 0 || !at) continue;
    const list = times.get(productId) ?? [];
    list.push(at.getTime());
    times.set(productId, list);
  }
  return times;
}

function hasInboundBetween(
  times: number[],
  start: number,
  end: number,
): boolean {
  if (!(start < end)) return false;
  return times.some((time) => time > start && time < end);
}

function isQualifyingInboundStatus(status: number | string | null | undefined) {
  return QUALIFYING_INBOUND_STATUSES.has(Number(status));
}

function eventTime(
  lineCreatedAt?: Date | string | null,
  monthCreatedAt?: Date | string | null,
  demandCreatedAt?: Date | string | null,
): number {
  return (
    toDateTime(lineCreatedAt)?.getTime() ??
    toDateTime(monthCreatedAt)?.getTime() ??
    toDateTime(demandCreatedAt)?.getTime() ??
    0
  );
}

function pushDetail(
  detailsByProduct: Map<number, CustomerDemandDetail[]>,
  event: DemandEvent,
  skipped: boolean,
) {
  const details = detailsByProduct.get(event.productId) ?? [];
  details.push({
    monthId: event.monthId,
    customerId: event.customerId,
    customerName: event.customerName,
    demandMonth: event.demandMonth,
    quantityBase: event.quantityBase,
    skipped,
    skipReason: skipped ? 'INBOUND_BETWEEN' : null,
  });
  detailsByProduct.set(event.productId, details);
}

function sortDetails(details: CustomerDemandDetail[]): CustomerDemandDetail[] {
  return [...details].sort((a, b) => {
    if (Boolean(a.skipped) !== Boolean(b.skipped)) return a.skipped ? 1 : -1;
    if (a.demandMonth !== b.demandMonth) {
      return a.demandMonth.localeCompare(b.demandMonth);
    }
    return (a.monthId ?? 0) - (b.monthId ?? 0);
  });
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) return new Date(value.getTime());
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

function toDateTime(value?: Date | string | null): Date | null {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
