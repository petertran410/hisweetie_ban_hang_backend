export interface ColdCargoItem {
  invoiceId: number;
  invoiceCode: string;
  productId: number | null;
  productCode: string;
  productName: string;
}

export interface ColdCargoWarning {
  hasColdItems: boolean;
  coldItemCount: number;
  coldItems: ColdCargoItem[];
}

export interface ColdCargoInvoiceRecord {
  id: number;
  code: string;
  details?: ColdDetailRecord[] | null;
}

interface ColdDetailRecord {
  productId?: number | null;
  productCode?: string | null;
  productName?: string | null;
  product?: {
    id?: number;
    code?: string | null;
    name?: string | null;
    cargoType?: string | null;
  } | null;
}

interface PackingInvoiceRecord {
  invoice?: {
    id: number;
    code: string;
    details?: ColdDetailRecord[] | null;
  } | null;
}

function getUniqueKey(item: ColdCargoItem) {
  return [
    item.invoiceId,
    item.productId ?? '',
    item.productCode,
    item.productName,
  ].join(':');
}

export function buildColdCargoWarning(
  entries: readonly PackingInvoiceRecord[] | null | undefined,
): ColdCargoWarning {
  const unique = new Map<string, ColdCargoItem>();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const invoice = entry?.invoice;
    if (!invoice || !Array.isArray(invoice.details)) continue;

    for (const detail of invoice.details) {
      if (detail?.product?.cargoType !== 'COLD') continue;

      const item: ColdCargoItem = {
        invoiceId: invoice.id,
        invoiceCode: invoice.code,
        productId: detail.productId ?? detail.product?.id ?? null,
        productCode: detail.productCode ?? detail.product?.code ?? '',
        productName: detail.productName ?? detail.product?.name ?? '',
      };
      unique.set(getUniqueKey(item), item);
    }
  }

  const coldItems = [...unique.values()];
  return {
    hasColdItems: coldItems.length > 0,
    coldItemCount: coldItems.length,
    coldItems,
  };
}

export function summarizeColdCargoWarning(
  warning: ColdCargoWarning,
): Pick<ColdCargoWarning, 'hasColdItems' | 'coldItemCount'> {
  return {
    hasColdItems: warning.hasColdItems,
    coldItemCount: warning.coldItemCount,
  };
}

export function mapColdCargoInvoice(invoice: ColdCargoInvoiceRecord) {
  const warning = buildColdCargoWarning([{ invoice }]);
  return {
    hasColdItems: warning.hasColdItems,
    coldItemCount: warning.coldItemCount,
    coldItems: warning.coldItems,
  };
}
