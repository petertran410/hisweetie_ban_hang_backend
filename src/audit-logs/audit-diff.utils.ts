export interface AuditChange {
  field: string;
  label: string;
  from?: any;
  to?: any;
  type?: 'field_changed' | 'item_added' | 'item_removed' | 'item_changed';
  detail?: any;
}

const FIELD_LABELS: Record<string, Record<string, string>> = {
  common: {
    name: 'Tên',
    code: 'Mã',
    description: 'Ghi chú',
    status: 'Trạng thái',
    statusValue: 'Trạng thái',
    contactNumber: 'SĐT',
    email: 'Email',
    address: 'Địa chỉ',
    isActive: 'Hoạt động',
    wardName: 'Phường/Xã',
    taxCode: 'Mã số thuế',
  },
  orders: {
    orderDate: 'Ngày đặt hàng',
    grandTotal: 'Tổng tiền',
    discount: 'Chiết khấu',
    discountRatio: 'Tỉ lệ CK',
    paidAmount: 'Đã thanh toán',
    debtAmount: 'Công nợ',
    soldById: 'Người bán',
    customerId: 'Khách hàng',
    branchId: 'Chi nhánh',
    priceBookName: 'Bảng giá',
  },
  invoices: {
    purchaseDate: 'Ngày bán',
    grandTotal: 'Tổng tiền',
    totalAmount: 'Thành tiền',
    discount: 'Chiết khấu',
    discountRatio: 'Tỉ lệ CK',
    paidAmount: 'Đã thanh toán',
    debtAmount: 'Công nợ',
    usingCod: 'Thu hộ COD',
  },
  products: {
    basePrice: 'Giá bán',
    costPrice: 'Giá vốn',
    weight: 'Trọng lượng',
    unit: 'Đơn vị',
    categoryId: 'Danh mục',
    trademarkId: 'Thương hiệu',
    allowSale: 'Cho phép bán',
  },
  customers: {
    totalPurchased: 'Tổng mua',
    totalDebt: 'Công nợ',
  },
  suppliers: {
    totalDebt: 'Công nợ',
  },
  purchase_orders: {
    grandTotal: 'Tổng tiền',
    paidAmount: 'Đã thanh toán',
    supplierDebt: 'Công nợ NCC',
  },
  order_suppliers: {
    totalAmt: 'Tổng tiền',
    paidAmount: 'Đã thanh toán',
    supplierDebt: 'Công nợ NCC',
    orderDate: 'Ngày đặt',
  },
  transfers: {
    fromBranchName: 'Kho nguồn',
    toBranchName: 'Kho đích',
    noteBySource: 'Ghi chú nguồn',
    noteByDestination: 'Ghi chú đích',
  },
  cashflows: {
    amount: 'Số tiền',
    isReceipt: 'Loại phiếu',
    transDate: 'Ngày giao dịch',
  },
};

const IGNORED_FIELDS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'items',
  'details',
  'payments',
  'delivery',
  'customer',
  'branch',
  'soldBy',
  'creator',
  'order',
  'priceBook',
  'supplier',
  'user',
  'images',
  'invoices',
]);

function getLabel(entityType: string, field: string): string {
  return (
    FIELD_LABELS[entityType]?.[field] || FIELD_LABELS.common[field] || field
  );
}

function normalizeValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export function buildChanges(
  entityType: string,
  oldData: Record<string, any>,
  newData: Record<string, any>,
): AuditChange[] {
  const changes: AuditChange[] = [];

  const allKeys = new Set([
    ...Object.keys(oldData || {}),
    ...Object.keys(newData || {}),
  ]);

  for (const field of allKeys) {
    if (IGNORED_FIELDS.has(field)) continue;

    const oldVal = oldData?.[field];
    const newVal = newData?.[field];

    const oldNorm = normalizeValue(oldVal);
    const newNorm = normalizeValue(newVal);

    if (oldNorm !== newNorm) {
      changes.push({
        field,
        label: getLabel(entityType, field),
        from: oldVal ?? null,
        to: newVal ?? null,
        type: 'field_changed',
      });
    }
  }

  return changes;
}

export function buildItemChanges(
  oldItems: Array<{
    productId: number;
    productName?: string;
    productCode?: string;
    quantity: number;
    price: number;
    discount?: number;
  }>,
  newItems: Array<{
    productId: number;
    productName?: string;
    productCode?: string;
    quantity: number;
    price: number;
    discount?: number;
  }>,
): AuditChange[] {
  const changes: AuditChange[] = [];

  const oldMap = new Map(oldItems.map((i) => [i.productId, i]));
  const newMap = new Map(newItems.map((i) => [i.productId, i]));

  for (const [productId, newItem] of newMap) {
    const oldItem = oldMap.get(productId);
    if (!oldItem) {
      changes.push({
        field: 'items',
        label: 'Sản phẩm',
        type: 'item_added',
        detail: {
          productId,
          productName: newItem.productName || newItem.productCode,
          quantity: newItem.quantity,
          price: newItem.price,
        },
      });
    } else {
      const diffs: string[] = [];
      if (Number(oldItem.quantity) !== Number(newItem.quantity)) {
        diffs.push(`SL: ${oldItem.quantity} → ${newItem.quantity}`);
      }
      if (Number(oldItem.price) !== Number(newItem.price)) {
        diffs.push(`Giá: ${oldItem.price} → ${newItem.price}`);
      }
      if (Number(oldItem.discount || 0) !== Number(newItem.discount || 0)) {
        diffs.push(`CK: ${oldItem.discount || 0} → ${newItem.discount || 0}`);
      }
      if (diffs.length > 0) {
        changes.push({
          field: 'items',
          label: 'Sản phẩm',
          type: 'item_changed',
          detail: {
            productId,
            productName: newItem.productName || newItem.productCode,
            changes: diffs,
          },
        });
      }
    }
  }

  for (const [productId, oldItem] of oldMap) {
    if (!newMap.has(productId)) {
      changes.push({
        field: 'items',
        label: 'Sản phẩm',
        type: 'item_removed',
        detail: {
          productId,
          productName: oldItem.productName || oldItem.productCode,
          quantity: oldItem.quantity,
          price: oldItem.price,
        },
      });
    }
  }

  return changes;
}
