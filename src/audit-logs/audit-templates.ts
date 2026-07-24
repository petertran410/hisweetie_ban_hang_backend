export const AUDIT_TEMPLATES: Record<
  string,
  { template: string; category: string; severity: string }
> = {
  ORDER_CREATE: {
    template:
      'Tạo đơn đặt hàng {orderCode} (Phiếu tạm), khách hàng: {customerName}, Thuế: Tắt thuế',
    category: 'order',
    severity: 'info',
  },
  ORDER_UPDATE: {
    template:
      'Cập nhật thông tin đơn đặt hàng: {orderCode} ({statusValue}), khách hàng: {customerName}',
    category: 'order',
    severity: 'info',
  },
  ORDER_DELETE: {
    template: 'Hủy đơn đặt hàng: {orderCode}',
    category: 'order',
    severity: 'warning',
  },
  ORDER_CANCEL: {
    template: 'Hủy đơn hàng {orderCode}, khách hàng: {customerName}',
    category: 'order',
    severity: 'warning',
  },

  INVOICE_CREATE: {
    template:
      'Tạo hóa đơn {invoiceCode} (cho đơn đặt hàng: {orderCode}), khách hàng {customerName}',
    category: 'invoice',
    severity: 'info',
  },
  INVOICE_UPDATE: {
    template: 'Cập nhật hóa đơn {invoiceCode}',
    category: 'invoice',
    severity: 'info',
  },
  INVOICE_DELETE: {
    template: 'Xóa hóa đơn {invoiceCode}',
    category: 'invoice',
    severity: 'warning',
  },
  INVOICE_CANCEL: {
    template: 'Hủy hóa đơn {invoiceCode} do cập nhật thông tin',
    category: 'invoice',
    severity: 'warning',
  },
  INVOICE_CREATE_FROM_CANCELLED: {
    template: 'Tạo hóa đơn {invoiceCode} từ hóa đơn đã hủy {oldInvoiceCode}',
    category: 'invoice',
    severity: 'info',
  },

  INVOICE_PAYMENT_CREATE: {
    template:
      'Tạo phiếu thu {paymentCode} cho hóa đơn {invoiceCode}, giá trị: {amount}',
    category: 'payment',
    severity: 'info',
  },
  INVOICE_PAYMENT_DELETE: {
    template: 'Xóa phiếu thu {paymentCode} của hóa đơn {invoiceCode}',
    category: 'payment',
    severity: 'warning',
  },

  ORDER_PAYMENT_CREATE: {
    template:
      'Tạo phiếu thu {paymentCode} cho đơn hàng {orderCode}, giá trị: {amount}',
    category: 'payment',
    severity: 'info',
  },
  ORDER_PAYMENT_DELETE: {
    template: 'Xóa phiếu thu {paymentCode} của đơn hàng {orderCode}',
    category: 'payment',
    severity: 'warning',
  },

  PRODUCT_CREATE: {
    template: 'Thêm sản phẩm {productName} ({productCode}), giá {basePrice}',
    category: 'product',
    severity: 'info',
  },
  PRODUCT_UPDATE: {
    template: 'Cập nhật sản phẩm {productName} ({productCode})',
    category: 'product',
    severity: 'info',
  },
  PRODUCT_DELETE: {
    template: 'Xóa sản phẩm {productName} ({productCode})',
    category: 'product',
    severity: 'warning',
  },
  PRODUCT_BULK_IMPORT: {
    template:
      'Import sản phẩm từ file "{fileName}": {importedCount} tạo mới, {updatedCount} cập nhật',
    category: 'product',
    severity: 'info',
  },

  PACKING_SLIP_UPDATE: {
    template: 'Cập nhật phiếu đóng hàng {packingCode}',
    category: 'packing',
    severity: 'info',
  },
  PACKING_HANG_UPDATE: {
    template: 'Cập nhật phiếu treo hàng {packingCode}',
    category: 'packing',
    severity: 'info',
  },
  PACKING_LOADING_UPDATE: {
    template: 'Cập nhật phiếu xếp hàng lên xe {packingCode}',
    category: 'packing',
    severity: 'info',
  },

  CUSTOMER_CREATE: {
    template:
      'Thêm khách hàng {customerName} (Mã: {customerCode}), SĐT: {contactNumber}',
    category: 'customer',
    severity: 'info',
  },
  CUSTOMER_UPDATE: {
    template:
      'Cập nhật thông tin khách hàng {customerName} (Mã: {customerCode})',
    category: 'customer',
    severity: 'info',
  },
  CUSTOMER_DELETE: {
    template: 'Xóa khách hàng {customerName} (Mã: {customerCode})',
    category: 'customer',
    severity: 'warning',
  },

  SUPPLIER_CREATE: {
    template: 'Thêm nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
    severity: 'info',
  },
  SUPPLIER_UPDATE: {
    template: 'Cập nhật nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
    severity: 'info',
  },
  SUPPLIER_DELETE: {
    template: 'Xóa nhà cung cấp {supplierName} (Mã: {supplierCode})',
    category: 'supplier',
    severity: 'warning',
  },

  INVENTORY_ADJUST: {
    template: 'Kiểm kho {productName}: {oldQty} → {newQty}',
    category: 'inventory',
    severity: 'info',
  },

  TRANSFER_CREATE: {
    template:
      'Tạo phiếu chuyển kho {transferCode} từ {fromBranch} → {toBranch}',
    category: 'transfer',
    severity: 'info',
  },
  TRANSFER_UPDATE: {
    template: 'Cập nhật phiếu chuyển kho {transferCode}',
    category: 'transfer',
    severity: 'info',
  },
  TRANSFER_DELETE: {
    template: 'Xóa phiếu chuyển kho {transferCode}',
    category: 'transfer',
    severity: 'warning',
  },
  TRANSFER_CANCEL: {
    template: 'Hủy phiếu chuyển kho {transferCode} ({cancelReason})',
    category: 'transfer',
    severity: 'warning',
  },
  TRANSFER_SHORTAGE_RESOLVE: {
    template:
      'Đồng bộ hoàn shortage phiếu {transferCode}: {shortageCount} sản phẩm được trả tồn về kho chuyển',
    category: 'transfer',
    severity: 'info',
  },

  PURCHASE_ORDER_CREATE: {
    template: 'Tạo phiếu nhập hàng {purchaseOrderCode} từ NCC {supplierName}',
    category: 'purchase_order',
    severity: 'info',
  },
  PURCHASE_ORDER_UPDATE: {
    template: 'Cập nhật phiếu nhập hàng {purchaseOrderCode}',
    category: 'purchase_order',
    severity: 'info',
  },
  PURCHASE_ORDER_DELETE: {
    template: 'Xóa phiếu nhập hàng {purchaseOrderCode}',
    category: 'purchase_order',
    severity: 'warning',
  },
  PURCHASE_ORDER_CANCEL: {
    template: 'Hủy phiếu nhập hàng {purchaseOrderCode}, NCC: {supplierName}',
    category: 'purchase_order',
    severity: 'warning',
  },
  PURCHASE_ORDER_PAYMENT_CREATE: {
    template:
      'Tạo thanh toán {paymentCode} cho nhập hàng {purchaseOrderCode}, giá trị: {amount}',
    category: 'payment',
    severity: 'info',
  },
  PURCHASE_ORDER_PAYMENT_DELETE: {
    template: 'Xóa thanh toán {paymentCode} của nhập hàng {purchaseOrderCode}',
    category: 'payment',
    severity: 'warning',
  },

  ORDER_SUPPLIER_CREATE: {
    template: 'Tạo đặt hàng nhập {orderSupplierCode} từ NCC {supplierName}',
    category: 'order_supplier',
    severity: 'info',
  },
  ORDER_SUPPLIER_UPDATE: {
    template: 'Cập nhật đặt hàng nhập {orderSupplierCode}',
    category: 'order_supplier',
    severity: 'info',
  },
  ORDER_SUPPLIER_DELETE: {
    template: 'Xóa đặt hàng nhập {orderSupplierCode}',
    category: 'order_supplier',
    severity: 'warning',
  },
  ORDER_SUPPLIER_CANCEL: {
    template: 'Hủy đặt hàng nhập {orderSupplierCode}, NCC: {supplierName}',
    category: 'order_supplier',
    severity: 'warning',
  },
  ORDER_SUPPLIER_PAYMENT_CREATE: {
    template:
      'Tạo thanh toán {paymentCode} cho đặt hàng nhập {orderSupplierCode}, giá trị: {amount}',
    category: 'payment',
    severity: 'info',
  },
  ORDER_SUPPLIER_PAYMENT_DELETE: {
    template:
      'Xóa thanh toán {paymentCode} của đặt hàng nhập {orderSupplierCode}',
    category: 'payment',
    severity: 'warning',
  },

  ORDER_SUPPLIER_COMPLETE: {
    template:
      'Chốt hoàn thành đặt hàng nhập {orderSupplierCode} (NCC không giao nốt phần còn thiếu)',
    category: 'order_supplier',
    severity: 'info',
  },

  VEHICLE_SHIPMENT_CREATE: {
    template: 'Tạo phiếu ghép xe {vehicleShipmentCode}',
    category: 'order_supplier',
    severity: 'info',
  },
  VEHICLE_SHIPMENT_UPDATE: {
    template: 'Cập nhật phiếu ghép xe {vehicleShipmentCode}',
    category: 'order_supplier',
    severity: 'info',
  },
  VEHICLE_SHIPMENT_CANCEL: {
    template: 'Hủy phiếu ghép xe {vehicleShipmentCode}',
    category: 'order_supplier',
    severity: 'warning',
  },
  VEHICLE_SHIPMENT_CREATE_PO: {
    template: 'Tạo {count} phiếu nhập từ phiếu ghép xe {vehicleShipmentCode}',
    category: 'order_supplier',
    severity: 'info',
  },
  VEHICLE_SHIPMENT_RESOLVE_ITEM: {
    template:
      'Xử lý chênh lệch sau nhập trên phiếu ghép xe {vehicleShipmentCode}',
    category: 'order_supplier',
    severity: 'info',
  },

  CASHFLOW_CREATE: {
    template: '{flowType} tiền {amount} - {description}',
    category: 'payment',
    severity: 'info',
  },
  CASHFLOW_UPDATE: {
    template: 'Cập nhật phiếu {flowType} {cashflowCode}',
    category: 'payment',
    severity: 'info',
  },
  CASHFLOW_DELETE: {
    template: 'Xóa phiếu {flowType} {cashflowCode}',
    category: 'payment',
    severity: 'warning',
  },

  PRODUCTION_CREATE: {
    template: 'Tạo phiếu sản xuất {productionCode}',
    category: 'production',
    severity: 'info',
  },
  PRODUCTION_UPDATE: {
    template: 'Cập nhật phiếu sản xuất {productionCode}',
    category: 'production',
    severity: 'info',
  },
  PRODUCTION_DELETE: {
    template: 'Xóa phiếu sản xuất {productionCode}',
    category: 'production',
    severity: 'warning',
  },

  DESTRUCTION_CREATE: {
    template: 'Tạo phiếu xuất hủy {destructionCode}',
    category: 'destruction',
    severity: 'info',
  },
  DESTRUCTION_UPDATE: {
    template: 'Cập nhật phiếu xuất hủy {destructionCode}',
    category: 'destruction',
    severity: 'info',
  },
  DESTRUCTION_DELETE: {
    template: 'Xóa phiếu xuất hủy {destructionCode}',
    category: 'destruction',
    severity: 'warning',
  },
  DESTRUCTION_CANCEL: {
    template: 'Hủy phiếu xuất hủy {destructionCode}',
    category: 'destruction',
    severity: 'warning',
  },

  INTERNAL_USE_CREATE: {
    template: 'Tạo phiếu xuất dùng nội bộ {internalUseCode}',
    category: 'internal_use',
    severity: 'info',
  },
  INTERNAL_USE_UPDATE: {
    template: 'Cập nhật phiếu xuất dùng nội bộ {internalUseCode}',
    category: 'internal_use',
    severity: 'info',
  },
  INTERNAL_USE_DELETE: {
    template: 'Xóa phiếu xuất dùng nội bộ {internalUseCode}',
    category: 'internal_use',
    severity: 'warning',
  },
  INTERNAL_USE_CANCEL: {
    template: 'Hủy phiếu xuất dùng nội bộ {internalUseCode}',
    category: 'internal_use',
    severity: 'warning',
  },

  PACKING_SLIP_CREATE: {
    template: 'Tạo phiếu đóng hàng {packingCode}',
    category: 'packing',
    severity: 'info',
  },
  PACKING_SLIP_DELETE: {
    template: 'Xóa phiếu đóng hàng {packingCode}',
    category: 'packing',
    severity: 'warning',
  },
  PACKING_HANG_CREATE: {
    template: 'Tạo phiếu treo hàng {packingCode}',
    category: 'packing',
    severity: 'info',
  },
  PACKING_HANG_DELETE: {
    template: 'Xóa phiếu treo hàng {packingCode}',
    category: 'packing',
    severity: 'warning',
  },
  PACKING_LOADING_CREATE: {
    template: 'Tạo phiếu xếp hàng lên xe {packingCode}',
    category: 'packing',
    severity: 'info',
  },
  PACKING_LOADING_DELETE: {
    template: 'Xóa phiếu xếp hàng lên xe {packingCode}',
    category: 'packing',
    severity: 'warning',
  },

  USER_CREATE: {
    template: 'Thêm người dùng {userName} ({userEmail})',
    category: 'user',
    severity: 'info',
  },
  USER_UPDATE: {
    template: 'Cập nhật người dùng {userName}',
    category: 'user',
    severity: 'info',
  },
  USER_DELETE: {
    template: 'Xóa người dùng {userName}',
    category: 'user',
    severity: 'critical',
  },

  BRANCH_CREATE: {
    template: 'Thêm chi nhánh {branchName} ({branchCode})',
    category: 'branch',
    severity: 'info',
  },
  BRANCH_UPDATE: {
    template: 'Cập nhật chi nhánh {branchName}',
    category: 'branch',
    severity: 'info',
  },
  BRANCH_DELETE: {
    template: 'Xóa chi nhánh {branchName}',
    category: 'branch',
    severity: 'critical',
  },

  BANK_ACCOUNT_CREATE: {
    template: 'Thêm tài khoản ngân hàng {accountName} ({bankName})',
    category: 'setting',
    severity: 'info',
  },
  BANK_ACCOUNT_UPDATE: {
    template: 'Cập nhật tài khoản ngân hàng {accountName}',
    category: 'setting',
    severity: 'info',
  },
  BANK_ACCOUNT_DELETE: {
    template: 'Xóa tài khoản ngân hàng {accountName}',
    category: 'setting',
    severity: 'warning',
  },

  PRICE_BOOK_CREATE: {
    template: 'Tạo bảng giá {priceBookName}',
    category: 'setting',
    severity: 'info',
  },
  PRICE_BOOK_UPDATE: {
    template: 'Cập nhật bảng giá {priceBookName}',
    category: 'setting',
    severity: 'info',
  },
  PRICE_BOOK_DELETE: {
    template: 'Xóa bảng giá {priceBookName}',
    category: 'setting',
    severity: 'warning',
  },
  PRICE_BOOK_ADD_PRODUCTS: {
    template: 'Thêm {productCount} sản phẩm vào bảng giá {priceBookName}',
    category: 'setting',
    severity: 'info',
  },
  PRICE_BOOK_REMOVE_PRODUCTS: {
    template: 'Xóa {productCount} sản phẩm khỏi bảng giá {priceBookName}',
    category: 'setting',
    severity: 'warning',
  },
  PRICE_BOOK_UPDATE_PRODUCT_PRICE: {
    template:
      'Cập nhật giá sản phẩm {productName} trong bảng giá {priceBookName}: {oldPrice} → {newPrice}',
    category: 'setting',
    severity: 'info',
  },

  SETTINGS_UPDATE: {
    template: 'Cập nhật cài đặt hệ thống',
    category: 'setting',
    severity: 'warning',
  },

  ROLE_CREATE: {
    template: 'Tạo vai trò {roleName}',
    category: 'setting',
    severity: 'warning',
  },
  ROLE_UPDATE: {
    template: 'Cập nhật vai trò {roleName}',
    category: 'setting',
    severity: 'warning',
  },
  ROLE_DELETE: {
    template: 'Xóa vai trò {roleName}',
    category: 'setting',
    severity: 'critical',
  },
  ROLE_ASSIGN_PERMISSIONS: {
    template: 'Phân quyền vai trò {roleName}: {permissionCount} quyền',
    category: 'setting',
    severity: 'warning',
  },
  ROLE_ASSIGN_BRANCH_PERMISSIONS: {
    template:
      'Phân quyền vai trò {roleName} tại chi nhánh {branchName}: {permissionCount} quyền',
    category: 'setting',
    severity: 'warning',
  },

  INVENTORY_CHECK_CREATE: {
    template:
      'Tạo phiếu kiểm loại B {checkCode} tại {branchName}, {productCount} sản phẩm',
    category: 'inventory',
    severity: 'info',
  },
  INVENTORY_CHECK_CANCEL: {
    template: 'Hủy phiếu kiểm loại B {checkCode}',
    category: 'inventory',
    severity: 'warning',
  },

  INVENTORY_PROMO_CHECK_CREATE: {
    template:
      'Tạo phiếu kiểm hàng KM {checkCode} tại {branchName}, {productCount} sản phẩm',
    category: 'inventory',
    severity: 'info',
  },
  INVENTORY_PROMO_CHECK_CANCEL: {
    template: 'Hủy phiếu kiểm hàng KM {checkCode}',
    category: 'inventory',
    severity: 'warning',
  },

  STOCK_AUDIT_CREATE: {
    template:
      'Tạo phiếu kiểm kho {auditCode} tại {branchName}, {productCount} sản phẩm',
    category: 'inventory',
    severity: 'info',
  },
  STOCK_AUDIT_UPDATE: {
    template: 'Cập nhật phiếu kiểm kho {auditCode}',
    category: 'inventory',
    severity: 'info',
  },
  STOCK_AUDIT_COMPLETE: {
    template: 'Hoàn thành phiếu kiểm kho {auditCode}, lệch tổng: {totalDiff}',
    category: 'inventory',
    severity: 'warning',
  },
  STOCK_AUDIT_CANCEL: {
    template: 'Hủy phiếu kiểm kho {auditCode}',
    category: 'inventory',
    severity: 'warning',
  },

  INVENTORY_CONDITION_UPDATE: {
    template: 'Cập nhật tình trạng tồn {productName} tại {branchName}',
    category: 'inventory',
    severity: 'info',
  },

  RETURN_ORDER_CREATE: {
    template: 'Tạo phiếu trả hàng {returnOrderCode} từ hóa đơn {invoiceCodes}',
    category: 'return_order',
    severity: 'info',
  },
  RETURN_ORDER_REQUEST_DRAFT: {
    template: 'Lưu phiếu tạm bước 1 trả hàng {returnOrderCode}',
    category: 'return_order',
    severity: 'info',
  },
  RETURN_ORDER_REQUEST_COMPLETE: {
    template: 'Hoàn thành bước 1 trả hàng {returnOrderCode}',
    category: 'return_order',
    severity: 'info',
  },
  RETURN_ORDER_STOCK_RECEIVED: {
    template:
      'Xác nhận nhận hàng trả phiếu {returnOrderCode}, hoàn tiền: {refundAmount}',
    category: 'return_order',
    severity: 'info',
  },
  RETURN_ORDER_REFUND_CONFIRMED: {
    template:
      'Xác nhận hoàn tiền phiếu trả hàng {returnOrderCode} ({refundType})',
    category: 'return_order',
    severity: 'info',
  },
  RETURN_ORDER_CANCEL: {
    template: 'Hủy phiếu trả hàng {returnOrderCode}',
    category: 'return_order',
    severity: 'warning',
  },

  CONSIGNMENT_CREATE: {
    template: 'Tạo phiếu ký gửi {consignmentCode}, khách hàng: {customerName}',
    category: 'consignment',
    severity: 'info',
  },
  CONSIGNMENT_UPDATE: {
    template: 'Cập nhật phiếu ký gửi {consignmentCode}',
    category: 'consignment',
    severity: 'info',
  },
  CONSIGNMENT_CANCEL: {
    template: 'Hủy phiếu ký gửi {consignmentCode}',
    category: 'consignment',
    severity: 'warning',
  },
  CONSIGNMENT_STOCK_OUT: {
    template:
      'Xuất kho ký gửi {consignmentCode} ({productCount} sản phẩm) khi chuyển trạng thái đóng/giao hàng',
    category: 'consignment',
    severity: 'info',
  },

  CONSIGNMENT_RETURN_CREATE: {
    template:
      'Tạo phiếu hoàn ký gửi {consignmentReturnCode}, khách hàng: {customerName}',
    category: 'consignment_return',
    severity: 'info',
  },
  CONSIGNMENT_RETURN_STOCK_RECEIVED: {
    template: 'Xác nhận nhận hàng hoàn ký gửi {consignmentReturnCode} vào kho',
    category: 'consignment_return',
    severity: 'info',
  },
  CONSIGNMENT_RETURN_CANCEL: {
    template: 'Hủy phiếu hoàn ký gửi {consignmentReturnCode}',
    category: 'consignment_return',
    severity: 'warning',
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
    let formatted = String(value ?? '');

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

export function getCategoryFromActionCode(actionCode: string): string {
  return AUDIT_TEMPLATES[actionCode]?.category || 'other';
}

export function getSeverityFromActionCode(actionCode: string): string {
  return AUDIT_TEMPLATES[actionCode]?.severity || 'info';
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
