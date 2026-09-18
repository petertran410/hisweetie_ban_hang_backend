export type CustomerDemandStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
export type CustomerDemandUnit = 'BASE' | 'CARTON';
export type CustomerDemandSkipReason = 'INBOUND_BETWEEN' | 'CUSTOMER_ORDER';

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

export interface PendingCustomerOrderEvent {
  productId: number;
  customerId?: number | null;
  orderDate: Date | string;
  quantity: number;
}

export interface CustomerDemandActualPurchaseInput {
  productId: number;
  customerId?: number | null;
  purchaseDate: Date | string | null | undefined;
  quantity: number;
}

export interface CustomerDemandDetail {
  monthId: number | null;
  customerId: number | null;
  customerName: string | null;
  demandMonth: string;
  quantityBase: number;
  customerOrderOffset?: number;
  /** Số lượng InvoiceDetail được phân bổ cho Demand này để đối chiếu. */
  actualPurchasedQuantity?: number;
  /** Phần được khấu trừ khỏi tổng nhu cầu dự báo. */
  deductedQuantity?: number;
  /** Demand còn chưa được khách mua sau khi đối chiếu hóa đơn. */
  remainingQuantity?: number;
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
  pendingCustomerOrders: PendingCustomerOrderEvent[] = [],
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
    pendingCustomerOrders,
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
  actualPurchases: CustomerDemandActualPurchaseInput[] = [],
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
    [],
    actualPurchases,
  );
}

function accumulateConfirmedDemand(
  months: CustomerDemandMonthInput[],
  includeMonth: (demandMonth: Date) => boolean,
  inboundOrders: InboundOrderEvent[],
  pendingCustomerOrders: PendingCustomerOrderEvent[] = [],
  actualPurchases?: CustomerDemandActualPurchaseInput[],
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
        createdAt: eventTime(
          line.createdAt,
          month.createdAt,
          month.demandCreatedAt,
        ),
      });
    }
  }

  const { kept, skipped } = collapseOverlappingDemand(events, inboundOrders);
  const adjusted = subtractPendingCustomerOrders(kept, pendingCustomerOrders);
  const demandForOutput =
    actualPurchases === undefined
      ? adjusted.kept
      : applyActualCustomerPurchases(adjusted.kept, actualPurchases);
  const totalByProduct = new Map<number, number>();
  const detailsByProduct = new Map<number, CustomerDemandDetail[]>();
  const includedMonths = new Set<string>();

  for (const event of demandForOutput) {
    totalByProduct.set(
      event.productId,
      (totalByProduct.get(event.productId) ?? 0) +
        (event.deductedQuantity ?? event.quantityBase),
    );
    includedMonths.add(event.demandMonth);
    pushDetail(detailsByProduct, event, false);
  }
  for (const event of skipped) {
    pushDetail(detailsByProduct, event, true);
  }
  for (const event of adjusted.fullyCovered) {
    pushDetail(detailsByProduct, event, true, 'CUSTOMER_ORDER');
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
  customerOrderOffset?: number;
  actualPurchasedQuantity?: number;
  deductedQuantity?: number;
  remainingQuantity?: number;
  createdAt: number;
}

/**
 * Demand OEM là nhu cầu dự kiến, còn Order khách đang chờ đã là nhu cầu chắc
 * chắn. Phần giao nhau theo cùng khách/SKU/tháng bị khấu trừ khỏi Demand OEM
 * để SOQ không cộng hai lần.
 */
function subtractPendingCustomerOrders(
  events: DemandEvent[],
  orders: PendingCustomerOrderEvent[],
): { kept: DemandEvent[]; fullyCovered: DemandEvent[] } {
  if (orders.length === 0) return { kept: events, fullyCovered: [] };

  const remainingByKey = new Map<string, number>();
  for (const order of orders) {
    const productId = Number(order.productId);
    const quantity = Number(order.quantity);
    const date = toDateTime(order.orderDate);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0 || !date) continue;
    const key = `${order.customerId ?? 0}:${productId}:${dateKey(
      startOfMonth(date),
    ).slice(0, 7)}`;
    remainingByKey.set(key, (remainingByKey.get(key) ?? 0) + quantity);
  }

  const kept: DemandEvent[] = [];
  const fullyCovered: DemandEvent[] = [];
  for (const event of events) {
    const key = `${event.customerId ?? 0}:${event.productId}:${event.demandMonth}`;
    const available = remainingByKey.get(key) ?? 0;
    if (available <= 0) {
      kept.push(event);
      continue;
    }
    const offset = Math.min(available, event.quantityBase);
    remainingByKey.set(key, available - offset);
    const quantityBase = event.quantityBase - offset;
    if (quantityBase <= 0) {
      fullyCovered.push(event);
    } else {
      kept.push({ ...event, quantityBase, customerOrderOffset: offset });
    }
  }
  return { kept, fullyCovered };
}

/**
 * Đối chiếu Demand đã collapse với lượng thực tế khách mua trên hóa đơn.
 *
 * Invoice được gom theo cùng khách/SKU/tháng. Khi có nhiều Demand cùng khóa,
 * lượng hóa đơn được phân bổ lần lượt để tổng khấu trừ không bao giờ vượt
 * tổng Demand và không bị nhân đôi ở từng dòng chi tiết.
 */
function applyActualCustomerPurchases(
  events: DemandEvent[],
  purchases: CustomerDemandActualPurchaseInput[],
): DemandEvent[] {
  const remainingByKey = new Map<string, number>();
  for (const purchase of purchases ?? []) {
    const productId = Number(purchase.productId);
    const quantity = Number(purchase.quantity);
    const purchaseDate = toDateTime(purchase.purchaseDate);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0 || !purchaseDate) continue;

    const key = `${purchase.customerId ?? 0}:${productId}:${dateKey(
      startOfMonth(purchaseDate),
    ).slice(0, 7)}`;
    remainingByKey.set(
      key,
      (remainingByKey.get(key) ?? 0) + quantity,
    );
  }

  return events.map((event) => {
    const key = `${event.customerId ?? 0}:${event.productId}:${event.demandMonth}`;
    const available = remainingByKey.get(key) ?? 0;
    const deducted = Math.min(available, event.quantityBase);
    remainingByKey.set(key, available - deducted);
    return {
      ...event,
      actualPurchasedQuantity: deducted,
      deductedQuantity: deducted,
      remainingQuantity: Math.max(0, event.quantityBase - deducted),
    };
  });
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
        hasInboundBetween(
          times,
          list[index].createdAt,
          list[index + 1].createdAt,
        )
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
  skipReason: CustomerDemandSkipReason | null = skipped
    ? 'INBOUND_BETWEEN'
    : null,
) {
  const details = detailsByProduct.get(event.productId) ?? [];
  details.push({
    monthId: event.monthId,
    customerId: event.customerId,
    customerName: event.customerName,
    demandMonth: event.demandMonth,
    quantityBase: event.quantityBase,
    ...(event.customerOrderOffset
      ? { customerOrderOffset: event.customerOrderOffset }
      : {}),
    ...(event.actualPurchasedQuantity !== undefined
      ? { actualPurchasedQuantity: event.actualPurchasedQuantity }
      : {}),
    ...(event.deductedQuantity !== undefined
      ? { deductedQuantity: event.deductedQuantity }
      : {}),
    ...(event.remainingQuantity !== undefined
      ? { remainingQuantity: event.remainingQuantity }
      : {}),
    skipped,
    skipReason,
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
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
