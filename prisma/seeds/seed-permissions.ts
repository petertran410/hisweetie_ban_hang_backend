import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PermissionData {
  name: string;
  resource: string;
  action: string;
  description: string;
  category: string;
  scope?: string;
}

const permissionsData: PermissionData[] = [
  // Products
  {
    name: 'products:view',
    resource: 'products',
    action: 'view',
    description: 'Xem sản phẩm',
    category: 'Sản phẩm',
  },
  {
    name: 'products:create',
    resource: 'products',
    action: 'create',
    description: 'Tạo sản phẩm',
    category: 'Sản phẩm',
  },
  {
    name: 'products:update',
    resource: 'products',
    action: 'update',
    description: 'Sửa sản phẩm',
    category: 'Sản phẩm',
  },
  {
    name: 'products:delete',
    resource: 'products',
    action: 'delete',
    description: 'Xóa sản phẩm',
    category: 'Sản phẩm',
  },
  {
    name: 'products:import',
    resource: 'products',
    action: 'import',
    description: 'Import sản phẩm',
    category: 'Sản phẩm',
  },
  {
    name: 'products:export',
    resource: 'products',
    action: 'export',
    description: 'Export sản phẩm',
    category: 'Sản phẩm',
  },

  // Products - Granular
  {
    name: 'products:view_cost_price',
    resource: 'products',
    action: 'view_cost_price',
    description: 'Xem giá vốn sản phẩm',
    category: 'Sản phẩm',
  },

  // Categories
  {
    name: 'categories:view',
    resource: 'categories',
    action: 'view',
    description: 'Xem danh mục',
    category: 'Sản phẩm',
  },
  {
    name: 'categories:create',
    resource: 'categories',
    action: 'create',
    description: 'Tạo danh mục',
    category: 'Sản phẩm',
  },
  {
    name: 'categories:update',
    resource: 'categories',
    action: 'update',
    description: 'Sửa danh mục',
    category: 'Sản phẩm',
  },
  {
    name: 'categories:delete',
    resource: 'categories',
    action: 'delete',
    description: 'Xóa danh mục',
    category: 'Sản phẩm',
  },

  // Trademarks
  {
    name: 'trademarks:view',
    resource: 'trademarks',
    action: 'view',
    description: 'Xem thương hiệu',
    category: 'Sản phẩm',
  },
  {
    name: 'trademarks:create',
    resource: 'trademarks',
    action: 'create',
    description: 'Tạo thương hiệu',
    category: 'Sản phẩm',
  },
  {
    name: 'trademarks:update',
    resource: 'trademarks',
    action: 'update',
    description: 'Sửa thương hiệu',
    category: 'Sản phẩm',
  },
  {
    name: 'trademarks:delete',
    resource: 'trademarks',
    action: 'delete',
    description: 'Xóa thương hiệu',
    category: 'Sản phẩm',
  },

  // Price Books
  {
    name: 'price_books:view',
    resource: 'price_books',
    action: 'view',
    description: 'Xem bảng giá',
    category: 'Sản phẩm',
  },
  {
    name: 'price_books:create',
    resource: 'price_books',
    action: 'create',
    description: 'Tạo bảng giá',
    category: 'Sản phẩm',
  },
  {
    name: 'price_books:update',
    resource: 'price_books',
    action: 'update',
    description: 'Sửa bảng giá',
    category: 'Sản phẩm',
  },
  {
    name: 'price_books:delete',
    resource: 'price_books',
    action: 'delete',
    description: 'Xóa bảng giá',
    category: 'Sản phẩm',
  },

  // Inventory
  {
    name: 'inventory:view',
    resource: 'inventory',
    action: 'view',
    description: 'Xem tồn kho',
    category: 'Kho',
  },
  {
    name: 'inventory:update',
    resource: 'inventory',
    action: 'update',
    description: 'Điều chỉnh tồn kho',
    category: 'Kho',
  },
  {
    name: 'inventory:export',
    resource: 'inventory',
    action: 'export',
    description: 'Xuất báo cáo tồn kho',
    category: 'Kho',
  },

  // Transfers
  {
    name: 'transfers:view',
    resource: 'transfers',
    action: 'view',
    description: 'Xem chuyển kho',
    category: 'Kho',
  },
  {
    name: 'transfers:create',
    resource: 'transfers',
    action: 'create',
    description: 'Tạo chuyển kho',
    category: 'Kho',
  },
  {
    name: 'transfers:update',
    resource: 'transfers',
    action: 'update',
    description: 'Sửa chuyển kho',
    category: 'Kho',
  },
  {
    name: 'transfers:delete',
    resource: 'transfers',
    action: 'delete',
    description: 'Xóa chuyển kho',
    category: 'Kho',
  },
  {
    name: 'transfers:approve',
    resource: 'transfers',
    action: 'approve',
    description: 'Duyệt chuyển kho',
    category: 'Kho',
  },

  // Productions
  {
    name: 'productions:view',
    resource: 'productions',
    action: 'view',
    description: 'Xem sản xuất',
    category: 'Kho',
  },
  {
    name: 'productions:create',
    resource: 'productions',
    action: 'create',
    description: 'Tạo sản xuất',
    category: 'Kho',
  },
  {
    name: 'productions:update',
    resource: 'productions',
    action: 'update',
    description: 'Sửa sản xuất',
    category: 'Kho',
  },
  {
    name: 'productions:delete',
    resource: 'productions',
    action: 'delete',
    description: 'Xóa sản xuất',
    category: 'Kho',
  },

  // Destructions
  {
    name: 'destructions:view',
    resource: 'destructions',
    action: 'view',
    description: 'Xem hủy hàng',
    category: 'Kho',
  },
  {
    name: 'destructions:create',
    resource: 'destructions',
    action: 'create',
    description: 'Tạo hủy hàng',
    category: 'Kho',
  },
  {
    name: 'destructions:update',
    resource: 'destructions',
    action: 'update',
    description: 'Sửa hủy hàng',
    category: 'Kho',
  },
  {
    name: 'destructions:delete',
    resource: 'destructions',
    action: 'delete',
    description: 'Xóa hủy hàng',
    category: 'Kho',
  },

  // Stock Audits (Kiểm kho)
  {
    name: 'stock_audits:view',
    resource: 'stock_audits',
    action: 'view',
    description: 'Xem kiểm kho',
    category: 'Kho',
  },
  {
    name: 'stock_audits:create',
    resource: 'stock_audits',
    action: 'create',
    description: 'Tạo kiểm kho',
    category: 'Kho',
  },
  {
    name: 'stock_audits:update',
    resource: 'stock_audits',
    action: 'update',
    description: 'Sửa/hoàn tất/hủy kiểm kho',
    category: 'Kho',
  },

  // Inventory Checks (Kiểm hàng loại B)
  {
    name: 'inventory_checks:view',
    resource: 'inventory_checks',
    action: 'view',
    description: 'Xem kiểm hàng loại B',
    category: 'Kho',
  },
  {
    name: 'inventory_checks:create',
    resource: 'inventory_checks',
    action: 'create',
    description: 'Tạo kiểm hàng loại B',
    category: 'Kho',
  },
  {
    name: 'inventory_checks:update',
    resource: 'inventory_checks',
    action: 'update',
    description: 'Sửa/hủy kiểm hàng loại B',
    category: 'Kho',
  },

  // Orders
  {
    name: 'orders:view',
    resource: 'orders',
    action: 'view',
    description: 'Xem đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:create',
    resource: 'orders',
    action: 'create',
    description: 'Tạo đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:update',
    resource: 'orders',
    action: 'update',
    description: 'Sửa đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:delete',
    resource: 'orders',
    action: 'delete',
    description: 'Xóa đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:approve',
    resource: 'orders',
    action: 'approve',
    description: 'Duyệt đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:cancel',
    resource: 'orders',
    action: 'cancel',
    description: 'Hủy đơn hàng',
    category: 'Bán hàng',
  },

  // Orders - Granular
  {
    name: 'orders:view_other_staff',
    resource: 'orders',
    action: 'view_other_staff',
    description: 'Xem đơn hàng của nhân viên khác',
    category: 'Bán hàng',
  },
  {
    name: 'orders:export',
    resource: 'orders',
    action: 'export',
    description: 'Xuất Excel đơn hàng',
    category: 'Bán hàng',
  },
  {
    name: 'orders:print',
    resource: 'orders',
    action: 'print',
    description: 'In đơn hàng',
    category: 'Bán hàng',
  },

  // Invoices
  {
    name: 'invoices:view',
    resource: 'invoices',
    action: 'view',
    description: 'Xem hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:create',
    resource: 'invoices',
    action: 'create',
    description: 'Tạo hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:update',
    resource: 'invoices',
    action: 'update',
    description: 'Sửa hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:delete',
    resource: 'invoices',
    action: 'delete',
    description: 'Xóa hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:print',
    resource: 'invoices',
    action: 'print',
    description: 'In hóa đơn',
    category: 'Bán hàng',
  },

  // Invoices - Granular
  {
    name: 'invoices:view_cost_price',
    resource: 'invoices',
    action: 'view_cost_price',
    description: 'Xem giá vốn trên hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:view_profit',
    resource: 'invoices',
    action: 'view_profit',
    description: 'Xem lợi nhuận trên hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:view_other_staff',
    resource: 'invoices',
    action: 'view_other_staff',
    description: 'Xem hóa đơn của nhân viên khác',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:export',
    resource: 'invoices',
    action: 'export',
    description: 'Xuất Excel hóa đơn',
    category: 'Bán hàng',
  },
  {
    name: 'invoices:cancel',
    resource: 'invoices',
    action: 'cancel',
    description: 'Hủy hóa đơn',
    category: 'Bán hàng',
  },

  // VAT Invoices (Misa / Thuế) — quyền tách riêng khỏi invoices
  {
    name: 'vat_invoices:view',
    resource: 'vat_invoices',
    action: 'view',
    description: 'Xem hóa đơn VAT (dữ liệu Misa)',
    category: 'Bán hàng',
  },
  {
    name: 'vat_invoices:push',
    resource: 'vat_invoices',
    action: 'push',
    description: 'Đẩy hóa đơn VAT lên Misa (đồng nghĩa đẩy lên thuế)',
    category: 'Bán hàng',
  },
  {
    name: 'vat_invoices:delete',
    resource: 'vat_invoices',
    action: 'delete',
    description: 'Xóa chứng từ Misa của hóa đơn VAT',
    category: 'Bán hàng',
  },

  // Customers
  {
    name: 'customers:view',
    resource: 'customers',
    action: 'view',
    description: 'Xem khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:create',
    resource: 'customers',
    action: 'create',
    description: 'Tạo khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:update',
    resource: 'customers',
    action: 'update',
    description: 'Sửa khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:delete',
    resource: 'customers',
    action: 'delete',
    description: 'Xóa khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:import',
    resource: 'customers',
    action: 'import',
    description: 'Import khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customers:export',
    resource: 'customers',
    action: 'export',
    description: 'Export khách hàng',
    category: 'Khách hàng',
  },

  // Customers - Granular
  {
    name: 'customers:view_debt',
    resource: 'customers',
    action: 'view_debt',
    description: 'Xem công nợ khách hàng',
    category: 'Khách hàng',
  },

  // Customer Groups
  {
    name: 'customer_groups:view',
    resource: 'customer_groups',
    action: 'view',
    description: 'Xem nhóm khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customer_groups:create',
    resource: 'customer_groups',
    action: 'create',
    description: 'Tạo nhóm khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customer_groups:update',
    resource: 'customer_groups',
    action: 'update',
    description: 'Sửa nhóm khách hàng',
    category: 'Khách hàng',
  },
  {
    name: 'customer_groups:delete',
    resource: 'customer_groups',
    action: 'delete',
    description: 'Xóa nhóm khách hàng',
    category: 'Khách hàng',
  },

  // Suppliers
  {
    name: 'suppliers:view',
    resource: 'suppliers',
    action: 'view',
    description: 'Xem nhà cung cấp',
    category: 'Nhà cung cấp',
  },
  {
    name: 'suppliers:create',
    resource: 'suppliers',
    action: 'create',
    description: 'Tạo nhà cung cấp',
    category: 'Nhà cung cấp',
  },
  {
    name: 'suppliers:update',
    resource: 'suppliers',
    action: 'update',
    description: 'Sửa nhà cung cấp',
    category: 'Nhà cung cấp',
  },
  {
    name: 'suppliers:delete',
    resource: 'suppliers',
    action: 'delete',
    description: 'Xóa nhà cung cấp',
    category: 'Nhà cung cấp',
  },

  // Order Suppliers
  {
    name: 'order_suppliers:view',
    resource: 'order_suppliers',
    action: 'view',
    description: 'Xem đơn đặt hàng NCC',
    category: 'Nhà cung cấp',
  },
  {
    name: 'order_suppliers:create',
    resource: 'order_suppliers',
    action: 'create',
    description: 'Tạo đơn đặt hàng NCC',
    category: 'Nhà cung cấp',
  },
  {
    name: 'order_suppliers:update',
    resource: 'order_suppliers',
    action: 'update',
    description: 'Sửa đơn đặt hàng NCC',
    category: 'Nhà cung cấp',
  },
  {
    name: 'order_suppliers:delete',
    resource: 'order_suppliers',
    action: 'delete',
    description: 'Xóa đơn đặt hàng NCC',
    category: 'Nhà cung cấp',
  },

  // Purchase Orders
  {
    name: 'purchase_orders:view',
    resource: 'purchase_orders',
    action: 'view',
    description: 'Xem nhập hàng',
    category: 'Nhà cung cấp',
  },
  {
    name: 'purchase_orders:create',
    resource: 'purchase_orders',
    action: 'create',
    description: 'Tạo nhập hàng',
    category: 'Nhà cung cấp',
  },
  {
    name: 'purchase_orders:update',
    resource: 'purchase_orders',
    action: 'update',
    description: 'Sửa nhập hàng',
    category: 'Nhà cung cấp',
  },
  {
    name: 'purchase_orders:delete',
    resource: 'purchase_orders',
    action: 'delete',
    description: 'Xóa nhập hàng',
    category: 'Nhà cung cấp',
  },

  // Purchase Orders - Granular
  {
    name: 'purchase_orders:view_price',
    resource: 'purchase_orders',
    action: 'view_price',
    description: 'Xem giá nhập hàng',
    category: 'Nhà cung cấp',
  },
  {
    name: 'purchase_orders:cancel',
    resource: 'purchase_orders',
    action: 'cancel',
    description: 'Hủy phiếu nhập hàng',
    category: 'Nhà cung cấp',
  },

  // Packing Slips
  {
    name: 'packing_slips:view',
    resource: 'packing_slips',
    action: 'view',
    description: 'Xem báo đơn',
    category: 'Giao hàng',
  },
  {
    name: 'packing_slips:create',
    resource: 'packing_slips',
    action: 'create',
    description: 'Tạo báo đơn',
    category: 'Giao hàng',
  },
  {
    name: 'packing_slips:update',
    resource: 'packing_slips',
    action: 'update',
    description: 'Sửa báo đơn',
    category: 'Giao hàng',
  },
  {
    name: 'packing_slips:delete',
    resource: 'packing_slips',
    action: 'delete',
    description: 'Xóa báo đơn',
    category: 'Giao hàng',
  },

  // Packing Hangs
  {
    name: 'packing_hangs:view',
    resource: 'packing_hangs',
    action: 'view',
    description: 'Xem báo treo',
    category: 'Giao hàng',
  },
  {
    name: 'packing_hangs:create',
    resource: 'packing_hangs',
    action: 'create',
    description: 'Tạo báo treo',
    category: 'Giao hàng',
  },
  {
    name: 'packing_hangs:update',
    resource: 'packing_hangs',
    action: 'update',
    description: 'Sửa báo treo',
    category: 'Giao hàng',
  },
  {
    name: 'packing_hangs:delete',
    resource: 'packing_hangs',
    action: 'delete',
    description: 'Xóa báo treo',
    category: 'Giao hàng',
  },

  // Packing Loadings
  {
    name: 'packing_loadings:view',
    resource: 'packing_loadings',
    action: 'view',
    description: 'Xem lên xe',
    category: 'Giao hàng',
  },
  {
    name: 'packing_loadings:create',
    resource: 'packing_loadings',
    action: 'create',
    description: 'Tạo lên xe',
    category: 'Giao hàng',
  },
  {
    name: 'packing_loadings:update',
    resource: 'packing_loadings',
    action: 'update',
    description: 'Sửa lên xe',
    category: 'Giao hàng',
  },
  {
    name: 'packing_loadings:delete',
    resource: 'packing_loadings',
    action: 'delete',
    description: 'Xóa lên xe',
    category: 'Giao hàng',
  },

  // Cash Flow
  {
    name: 'cash_flows:view',
    resource: 'cash_flows',
    action: 'view',
    description: 'Xem sổ quỹ',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:create',
    resource: 'cash_flows',
    action: 'create',
    description: 'Tạo phiếu thu/chi',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:update',
    resource: 'cash_flows',
    action: 'update',
    description: 'Sửa phiếu thu/chi',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:delete',
    resource: 'cash_flows',
    action: 'delete',
    description: 'Xóa phiếu thu/chi',
    category: 'Tài chính',
  },

  // Cash Flows - Granular
  {
    name: 'cash_flows:view_balance',
    resource: 'cash_flows',
    action: 'view_balance',
    description: 'Xem số dư quỹ',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:view_other_staff',
    resource: 'cash_flows',
    action: 'view_other_staff',
    description: 'Xem phiếu thu/chi của nhân viên khác',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:print',
    resource: 'cash_flows',
    action: 'print',
    description: 'In phiếu thu/chi',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:export',
    resource: 'cash_flows',
    action: 'export',
    description: 'Xuất Excel sổ quỹ',
    category: 'Tài chính',
  },
  {
    name: 'cash_flows:cancel',
    resource: 'cash_flows',
    action: 'cancel',
    description: 'Hủy phiếu thu/chi',
    category: 'Tài chính',
  },

  // Reports
  {
    name: 'reports:sales',
    resource: 'reports',
    action: 'sales',
    description: 'Báo cáo bán hàng',
    category: 'Báo cáo',
  },
  {
    name: 'reports:inventory',
    resource: 'reports',
    action: 'inventory',
    description: 'Báo cáo tồn kho',
    category: 'Báo cáo',
  },
  {
    name: 'reports:financial',
    resource: 'reports',
    action: 'financial',
    description: 'Báo cáo tài chính',
    category: 'Báo cáo',
  },
  {
    name: 'reports:customer',
    resource: 'reports',
    action: 'customer',
    description: 'Báo cáo khách hàng',
    category: 'Báo cáo',
  },

  // Users
  {
    name: 'users:view',
    resource: 'users',
    action: 'view',
    description: 'Xem người dùng',
    category: 'Quản trị',
  },
  {
    name: 'users:create',
    resource: 'users',
    action: 'create',
    description: 'Tạo người dùng',
    category: 'Quản trị',
  },
  {
    name: 'users:update',
    resource: 'users',
    action: 'update',
    description: 'Sửa người dùng',
    category: 'Quản trị',
  },
  {
    name: 'users:delete',
    resource: 'users',
    action: 'delete',
    description: 'Xóa người dùng',
    category: 'Quản trị',
  },

  // Roles
  {
    name: 'roles:view',
    resource: 'roles',
    action: 'view',
    description: 'Xem vai trò',
    category: 'Quản trị',
  },
  {
    name: 'roles:create',
    resource: 'roles',
    action: 'create',
    description: 'Tạo vai trò',
    category: 'Quản trị',
  },
  {
    name: 'roles:update',
    resource: 'roles',
    action: 'update',
    description: 'Sửa vai trò',
    category: 'Quản trị',
  },
  {
    name: 'roles:delete',
    resource: 'roles',
    action: 'delete',
    description: 'Xóa vai trò',
    category: 'Quản trị',
  },
  {
    name: 'roles:assign_permissions',
    resource: 'roles',
    action: 'assign_permissions',
    description: 'Phân quyền cho vai trò',
    category: 'Quản trị',
  },

  // Branches
  {
    name: 'branches:view',
    resource: 'branches',
    action: 'view',
    description: 'Xem chi nhánh',
    category: 'Quản trị',
  },
  {
    name: 'branches:create',
    resource: 'branches',
    action: 'create',
    description: 'Tạo chi nhánh',
    category: 'Quản trị',
  },
  {
    name: 'branches:update',
    resource: 'branches',
    action: 'update',
    description: 'Sửa chi nhánh',
    category: 'Quản trị',
  },
  {
    name: 'branches:delete',
    resource: 'branches',
    action: 'delete',
    description: 'Xóa chi nhánh',
    category: 'Quản trị',
  },

  // Audit Logs
  {
    name: 'audit_logs:view',
    resource: 'audit_logs',
    action: 'view',
    description: 'Xem lịch sử thao tác',
    category: 'Quản trị',
  },

  // Print Templates
  {
    name: 'print_templates:view',
    resource: 'print_templates',
    action: 'view',
    description: 'Xem mẫu in',
    category: 'Cấu hình',
  },
  {
    name: 'print_templates:create',
    resource: 'print_templates',
    action: 'create',
    description: 'Tạo mẫu in',
    category: 'Cấu hình',
  },
  {
    name: 'print_templates:update',
    resource: 'print_templates',
    action: 'update',
    description: 'Sửa mẫu in',
    category: 'Cấu hình',
  },
  {
    name: 'print_templates:delete',
    resource: 'print_templates',
    action: 'delete',
    description: 'Xóa mẫu in',
    category: 'Cấu hình',
  },
  {
    name: 'bank_accounts:view',
    resource: 'bank_accounts',
    action: 'view',
    description: 'Xem tài khoản ngân hàng',
    category: 'Quản trị',
  },
  {
    name: 'bank_accounts:create',
    resource: 'bank_accounts',
    action: 'create',
    description: 'Tạo tài khoản ngân hàng',
    category: 'Quản trị',
  },
  {
    name: 'bank_accounts:update',
    resource: 'bank_accounts',
    action: 'update',
    description: 'Sửa tài khoản ngân hàng',
    category: 'Quản trị',
  },
  {
    name: 'bank_accounts:delete',
    resource: 'bank_accounts',
    action: 'delete',
    description: 'Xóa tài khoản ngân hàng',
    category: 'Quản trị',
  },
  {
    name: 'return_orders:view',
    resource: 'return_orders',
    action: 'view',
    description: 'Xem trả hàng',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders:create',
    resource: 'return_orders',
    action: 'create',
    description: 'Tạo trả hàng',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders:update',
    resource: 'return_orders',
    action: 'update',
    description: 'Cập nhật trả hàng',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders:delete',
    resource: 'return_orders',
    action: 'delete',
    description: 'Hủy trả hàng',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders_price:view',
    resource: 'return_orders_price',
    action: 'view',
    description: 'Xem giá nhập lại trả hàng',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders_total_prices:view',
    resource: 'return_orders_total_prices',
    action: 'view',
    description: 'Xem tổng tiền hàng trả hàng',
    category: 'Bán hàng',
  },

  // Return Orders - Granular
  {
    name: 'return_orders:approve',
    resource: 'return_orders',
    action: 'approve',
    description: 'Duyệt trả hàng (xác nhận kho)',
    category: 'Bán hàng',
  },
  {
    name: 'return_orders:cancel',
    resource: 'return_orders',
    action: 'cancel',
    description: 'Hủy trả hàng',
    category: 'Bán hàng',
  },

  // POS - Trang bán hàng
  {
    name: 'pos_inventory:view',
    resource: 'pos_inventory',
    action: 'view',
    description: 'Xem tồn kho khi bán hàng',
    category: 'Bán hàng',
  },
  {
    name: 'pos_price:update',
    resource: 'pos_price',
    action: 'update',
    description: 'Sửa đơn giá sản phẩm khi bán hàng',
    category: 'Bán hàng',
  },
  {
    name: 'pos_discount:update',
    resource: 'pos_discount',
    action: 'update',
    description: 'Sửa giảm giá hóa đơn khi bán hàng',
    category: 'Bán hàng',
  },
  {
    name: 'pos_seller:update',
    resource: 'pos_seller',
    action: 'update',
    description: 'Sửa người bán khi bán hàng',
    category: 'Bán hàng',
  },
  {
    name: 'pos_payment:view',
    resource: 'pos_payment',
    action: 'view',
    description: 'Xem phần thanh toán của khách',
    category: 'Bán hàng',
  },
  {
    name: 'pos_payment:update',
    resource: 'pos_payment',
    action: 'update',
    description: 'Sửa phần thanh toán của khách',
    category: 'Bán hàng',
  },

  // Settings
  {
    name: 'settings:view',
    resource: 'settings',
    action: 'view',
    description: 'Xem cài đặt hệ thống',
    category: 'Cấu hình',
  },
  {
    name: 'settings:update',
    resource: 'settings',
    action: 'update',
    description: 'Sửa cài đặt hệ thống',
    category: 'Cấu hình',
  },
];

async function seedPermissions() {
  console.log('🌱 Seeding permissions...');

  await prisma.userBranchPermission.deleteMany({});
  await prisma.userPermission.deleteMany({});
  await prisma.rolePermission.deleteMany({});
  await prisma.permission.deleteMany({});

  for (const perm of permissionsData) {
    await prisma.permission.create({
      data: {
        name: perm.name,
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
        category: perm.category,
        scope: perm.scope || 'all',
      },
    });
  }

  console.log(`✅ Created ${permissionsData.length} permissions`);

  const superAdminRole = await prisma.role.upsert({
    where: { name: 'Super Admin' },
    update: {},
    create: {
      name: 'Super Admin',
      description: 'Quản trị viên cấp cao - Full quyền tự động',
    },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: {},
    create: {
      name: 'Admin',
      description: 'Quản trị viên - Cần được cấp quyền',
    },
  });

  const userRole = await prisma.role.upsert({
    where: { name: 'User' },
    update: {},
    create: {
      name: 'User',
      description: 'Người dùng - Cần được cấp quyền',
    },
  });

  console.log('✅ Created 3 roles: Super Admin, Admin, User');

  await prisma.rolePermission.deleteMany({
    where: {
      roleId: {
        in: [superAdminRole.id, adminRole.id, userRole.id],
      },
    },
  });

  const allPermissions = await prisma.permission.findMany();

  for (const perm of allPermissions) {
    await prisma.rolePermission.create({
      data: {
        roleId: superAdminRole.id,
        permissionId: perm.id,
      },
    });
  }

  console.log(
    `✅ Assigned ${allPermissions.length} permissions to Super Admin role`,
  );

  const adminPermissions = allPermissions.filter(
    (p) =>
      !['users:delete', 'roles:delete', 'branches:delete'].includes(p.name),
  );

  for (const perm of adminPermissions) {
    await prisma.rolePermission.create({
      data: {
        roleId: adminRole.id,
        permissionId: perm.id,
      },
    });
  }

  console.log(
    `✅ Assigned ${adminPermissions.length} permissions to Admin role`,
  );

  const userPermissions = allPermissions.filter(
    (p) =>
      // vat_invoices (Misa/Thuế) chỉ dành cho Super Admin + Admin — User không được nhận
      p.resource !== 'vat_invoices' &&
      (p.category === 'Bán hàng' ||
        p.category === 'Khách hàng' ||
        (p.category === 'Sản phẩm' && p.action === 'view') ||
        (p.category === 'Kho' && p.action === 'view')),
  );

  for (const perm of userPermissions) {
    await prisma.rolePermission.create({
      data: {
        roleId: userRole.id,
        permissionId: perm.id,
      },
    });
  }

  console.log(`✅ Assigned ${userPermissions.length} permissions to User role`);
  console.log('🎉 Seed permissions completed!');
}

seedPermissions()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
