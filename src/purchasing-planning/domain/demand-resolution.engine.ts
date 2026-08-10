import { INCLUDED_DEMAND_TYPES, RETURN_DEMAND_TYPES } from './constants';
import { toDateKey } from './date';
import {
  DemandDay,
  RawInventoryDemandRecord,
  RawInvoiceDemandRecord,
} from './models';

export interface DemandResolutionInput {
  invoiceDetails: RawInvoiceDemandRecord[];
  inventoryLogs: RawInventoryDemandRecord[];
  dates?: Array<string | Date>;
}

export function resolveDemand(input: DemandResolutionInput): DemandDay[] {
  const days = new Map<
    string,
    {
      invoice: number;
      inventory: number;
      hasInvoice: boolean;
      hasInventory: boolean;
    }
  >();
  const getDay = (date: string | Date) => {
    const key = toDateKey(date);
    if (!days.has(key)) {
      days.set(key, {
        invoice: 0,
        inventory: 0,
        hasInvoice: false,
        hasInventory: false,
      });
    }
    return days.get(key)!;
  };

  for (const date of input.dates ?? []) getDay(date);
  for (const record of input.invoiceDetails) {
    const day = getDay(record.date);
    day.invoice +=
      record.type === 'RETURN'
        ? -Math.abs(record.quantity)
        : Math.abs(record.quantity);
    day.hasInvoice = true;
  }

  for (const record of input.inventoryLogs) {
    const day = getDay(record.date);
    const type = record.transactionType.toUpperCase();
    const isSale = type === 'SALE' || type === 'SALE_OUT';
    // PRD §5.2: InvoiceDetail owns sales demand; InventoryLog only fills gaps.
    if (isSale && day.hasInvoice) continue;
    if (INCLUDED_DEMAND_TYPES.has(type)) {
      day.inventory += Math.abs(record.quantity);
      day.hasInventory = true;
    } else if (RETURN_DEMAND_TYPES.has(type)) {
      day.inventory -= Math.abs(record.quantity);
      day.hasInventory = true;
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      // PRD §5.2: returns cannot make net demand negative.
      demand: Math.max(0, day.invoice + day.inventory),
      source:
        day.hasInvoice && day.hasInventory
          ? 'HYBRID'
          : day.hasInvoice
            ? 'INVOICE_DETAIL'
            : day.hasInventory
              ? 'INVENTORY_LOG'
              : 'NONE',
    }));
}
