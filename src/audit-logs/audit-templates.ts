export const AUDIT_TEMPLATES: Record<
  string,
  { template: string; category: string }
> = {
  // Đơn hàng
  ORDER_CREATE: {
    template:
      'Tạo đơn đặt hàng {orderCode} cho khách hàng {customerName}, tổng tiền {totalAmount}',
    category: 'order',
  },
  ORDER_UPDATE: {
    template: 'Cập nhật đơn đặt hàng {orderCode}: {changesSummary}',
    category: 'order',
  },
  ORDER_CANCEL: {
    template: 'Hủy đơn đặt hàng {orderCode}',
    category: 'order',
  },

  // Hóa đơn
  INVOICE_CREATE: {
    template:
      'Tạo hóa đơn {invoiceCode} (cho đơn đặt hàng: {orderCode}), khách hàng {customerName}, tổng tiền {totalAmount}',
    category: 'invoice',
  },
  INVOICE_PAYMENT: {
    template: 'Thanh toán hóa đơn {invoiceCode}, số tiền {amount}',
    category: 'invoice',
  },

  // Sản phẩm
  PRODUCT_CREATE: {
    template: 'Thêm sản phẩm {productName} ({productCode}), giá {basePrice}',
    category: 'product',
  },
  PRODUCT_UPDATE: {
    template: 'Cập nhật sản phẩm {productName}: {changesSummary}',
    category: 'product',
  },
  PRODUCT_UPDATE_PRICE: {
    template: 'Đổi giá sản phẩm {productName} từ {oldPrice} → {newPrice}',
    category: 'product',
  },

  // Khách hàng
  CUSTOMER_CREATE: {
    template:
      'Thêm khách hàng {customerName} (Mã: {customerCode}), SĐT: {contactNumber}',
    category: 'customer',
  },
  CUSTOMER_UPDATE: {
    template:
      'Cập nhật thông tin khách hàng {customerName} (Mã: {customerCode})',
    category: 'customer',
  },

  // Nhà cung cấp
  SUPPLIER_CREATE: {
    template: 'Thêm nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
  },

  // Kho
  INVENTORY_ADJUST: {
    template:
      'Kiểm kho {productName}: {oldQty} → {newQty} (Chênh lệch: {diff})',
    category: 'inventory',
  },
  TRANSFER_CREATE: {
    template:
      'Tạo phiếu chuyển kho {transferCode} từ {fromBranch} → {toBranch}',
    category: 'transfer',
  },

  // Thu chi
  CASHFLOW_IN: {
    template: 'Thu tiền {amount} - {description}',
    category: 'payment',
  },
  CASHFLOW_OUT: {
    template: 'Chi tiền {amount} - {description}',
    category: 'payment',
  },

  // In/Xuất
  EXPORT_EXCEL: {
    template: 'Xuất file Excel: {fileName}',
    category: 'export',
  },
  PRINT_INVOICE: {
    template: 'In hóa đơn {invoiceCode}',
    category: 'print',
  },
};

export function renderAuditMessage(
  actionCode: string,
  params: Record<string, any>,
): string {
  const config = AUDIT_TEMPLATES[actionCode];
  if (!config) return `Thực hiện ${actionCode}`;

  let message = config.template;

  for (const [key, value] of Object.entries(params)) {
    let formatted = String(value);

    if (typeof value === 'number') {
      if (/price|amount|revenue|total|debt/i.test(key)) {
        formatted = new Intl.NumberFormat('vi-VN').format(value) + 'đ';
      } else if (/qty|quantity/i.test(key)) {
        formatted = new Intl.NumberFormat('vi-VN').format(value);
      }
    }

    message = message.replace(`{${key}}`, formatted);
  }

  return message;
}

export function getChangesSummary(oldData: any, newData: any): string {
  const changes: string[] = [];
  const keys = new Set([
    ...Object.keys(oldData || {}),
    ...Object.keys(newData || {}),
  ]);

  for (const key of keys) {
    if (oldData[key] !== newData[key]) {
      changes.push(`${key}: ${oldData[key]} → ${newData[key]}`);
    }
  }

  return changes.slice(0, 3).join(', ') + (changes.length > 3 ? '...' : '');
}
