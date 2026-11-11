interface InventoryLogPrices {
  refType?: string | null;
  costPrice?: unknown;
  transactionPrice?: unknown;
}

export function filterInventoryLogPrices<T extends InventoryLogPrices>(
  log: T,
  canViewCostPrice: boolean,
  canViewSalePrice: boolean,
): T {
  const filtered = { ...log };
  if (!canViewCostPrice) delete filtered.costPrice;

  let canViewTransactionPrice: boolean;
  switch (log.refType) {
    case 'invoice':
    case 'return_order':
    case 'consignment':
    case 'consignment_return':
      canViewTransactionPrice = canViewSalePrice;
      break;
    case 'purchase_order':
    case 'supplier_return':
      canViewTransactionPrice = canViewCostPrice;
      break;
    default:
      canViewTransactionPrice = canViewCostPrice && canViewSalePrice;
  }
  if (!canViewTransactionPrice) delete filtered.transactionPrice;
  return filtered;
}
