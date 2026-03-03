export const AUDIT_TEMPLATES: Record<
  string,
  { template: string; category: string }
> = {
  // Đơn hàng
  ORDER_CREATE: {
    template:
      'Tạo đơn đặt hàng {orderCode} (Phiếu tạm), khách hàng: {customerName}, Thuế: Tắt thuế',
    category: 'order',
  },
  ORDER_UPDATE: {
    template: 'Cập nhật thông tin đơn đặt hàng: {orderCode} ({statusValue})',
    category: 'order',
  },
  ORDER_DELETE: {
    template: 'Hủy đơn đặt hàng: {orderCode}',
    category: 'order',
  },

  // Hóa đơn
  INVOICE_CREATE: {
    template:
      'Tạo hóa đơn {invoiceCode} (cho đơn đặt hàng: {orderCode}), khách hàng {customerName}',
    category: 'invoice',
  },
  INVOICE_UPDATE: {
    template: 'Cập nhật hóa đơn {invoiceCode}',
    category: 'invoice',
  },
  INVOICE_DELETE: {
    template: 'Xóa hóa đơn {invoiceCode}',
    category: 'invoice',
  },

  // Sản phẩm
  PRODUCT_CREATE: {
    template: 'Thêm sản phẩm {productName} ({productCode}), giá {basePrice}',
    category: 'product',
  },
  PRODUCT_UPDATE: {
    template: 'Cập nhật sản phẩm {productName} ({productCode})',
    category: 'product',
  },
  PRODUCT_DELETE: {
    template: 'Xóa sản phẩm {productName} ({productCode})',
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
  CUSTOMER_DELETE: {
    template: 'Xóa khách hàng {customerName} (Mã: {customerCode})',
    category: 'customer',
  },

  // Nhà cung cấp
  SUPPLIER_CREATE: {
    template: 'Thêm nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
  },
  SUPPLIER_UPDATE: {
    template: 'Cập nhật nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
  },
  SUPPLIER_DELETE: {
    template: 'Xóa nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
  },

  // Kho
  INVENTORY_ADJUST: {
    template: 'Kiểm kho {productName}: {oldQty} → {newQty}',
    category: 'inventory',
  },
  TRANSFER_CREATE: {
    template:
      'Tạo phiếu chuyển kho {transferCode} từ {fromBranch} → {toBranch}',
    category: 'transfer',
  },
  TRANSFER_UPDATE: {
    template: 'Cập nhật phiếu chuyển kho {transferCode}',
    category: 'transfer',
  },
  TRANSFER_DELETE: {
    template: 'Xóa phiếu chuyển kho {transferCode}',
    category: 'transfer',
  },

  // Thu chi
  CASHFLOW_CREATE: {
    template: '{flowType} tiền {amount} - {description}',
    category: 'payment',
  },
  CASHFLOW_UPDATE: {
    template: 'Cập nhật phiếu {flowType} {cashflowCode}',
    category: 'payment',
  },
  CASHFLOW_DELETE: {
    template: 'Xóa phiếu {flowType} {cashflowCode}',
    category: 'payment',
  },

  // Người dùng
  USER_CREATE: {
    template: 'Thêm người dùng {userName} ({userEmail})',
    category: 'user',
  },
  USER_UPDATE: {
    template: 'Cập nhật người dùng {userName}',
    category: 'user',
  },
  USER_DELETE: {
    template: 'Xóa người dùng {userName}',
    category: 'user',
  },

  // Chi nhánh
  BRANCH_CREATE: {
    template: 'Thêm chi nhánh {branchName} ({branchCode})',
    category: 'branch',
  },
  BRANCH_UPDATE: {
    template: 'Cập nhật chi nhánh {branchName}',
    category: 'branch',
  },
  BRANCH_DELETE: {
    template: 'Xóa chi nhánh {branchName}',
    category: 'branch',
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
