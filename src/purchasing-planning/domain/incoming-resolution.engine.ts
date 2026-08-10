import { addDays, toDateKey } from './date';
import { IncomingOrderLine, IncomingResolution } from './models';

export interface IncomingResolutionInput {
  lines: IncomingOrderLine[];
  snapshotDate: string | Date;
  leadTimeDays: number;
}

function isIncomingStatus(status: string | number): boolean {
  const value = String(status).toUpperCase();
  return (
    value === '1' ||
    value === '2' ||
    value === 'CONFIRMED' ||
    value === 'PARTIAL'
  );
}

export function resolveIncoming(
  input: IncomingResolutionInput,
): IncomingResolution {
  const snapshotDate = toDateKey(input.snapshotDate);
  let hasOverdue = false;
  let hasStale = false;
  const receipts = input.lines
    .filter((line) => isIncomingStatus(line.status))
    .map((line) => {
      const quantity = Math.max(
        0,
        line.orderedQuantity - (line.receivedQuantity ?? 0),
      );
      const rawDate =
        line.expectedArrivalDate ??
        line.promisedDate ??
        (line.orderDate
          ? addDays(line.orderDate, input.leadTimeDays)
          : snapshotDate);
      const resolvedDate = toDateKey(rawDate);
      const overdue = resolvedDate < snapshotDate;
      if (overdue) hasOverdue = true;
      const overdueDays = overdue
        ? Math.floor(
            (new Date(`${snapshotDate}T00:00:00.000Z`).getTime() -
              new Date(`${resolvedDate}T00:00:00.000Z`).getTime()) /
              86_400_000,
          )
        : 0;
      if (overdueDays > 30) {
        hasStale = true;
        return null;
      }
      const date = overdue
        ? addDays(
            snapshotDate,
            overdueDays <= 7 ? 3 : Math.ceil(input.leadTimeDays * 0.5),
          )
        : resolvedDate;
      return {
        id: line.id,
        date,
        quantity,
        overdue,
      };
    })
    .filter(
      (receipt): receipt is NonNullable<typeof receipt> =>
        receipt !== null && receipt.quantity > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    total: receipts.reduce((total, receipt) => total + receipt.quantity, 0),
    receipts,
    flags: [
      ...(hasOverdue ? (['OVERDUE_SHIPMENT'] as const) : []),
      ...(hasStale ? (['SHIPMENT_STALE'] as const) : []),
    ],
  };
}
