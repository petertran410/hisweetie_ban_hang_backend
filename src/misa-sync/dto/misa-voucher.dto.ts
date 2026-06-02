/**
 * Request body để tạo chứng từ bán hàng
 */
export interface MisaSaveVoucherRequestDto {
  app_id: string;
  org_company_code: string;
  voucher: MisaSaVoucherDto[];
}

/**
 * Chứng từ bán hàng (voucher_type = 13, reftype = 3530/3531/3537)
 */
export interface MisaSaVoucherDto {
  // Required fields
  voucher_type: number;
  org_refid: string;
  org_refno: string;
  branch_id: string;
  reftype: number;
  posted_date: string;
  refdate: string;
  is_sale_with_outward: boolean;

  // Totals (required for sa_voucher)
  total_sale_amount_oc: number;
  total_sale_amount: number;
  total_amount_oc: number;
  total_amount: number;
  total_discount_amount_oc: number;
  total_discount_amount: number;
  total_vat_amount_oc: number;
  total_vat_amount: number;

  // Invoice info
  org_reftype?: number | null;
  org_reftype_name?: string;

  // Customer info
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  account_object_tax_code?: string;

  // Employee info
  employee_id?: string;
  employee_code?: string;
  employee_name?: string;

  // Discount info
  discount_type?: number;
  discount_rate_voucher?: number;

  // Other info
  exchange_rate?: number;
  currency_id?: string;
  include_invoice?: number;
  payer?: string;
  journal_memo?: string;

  // Outward info (khi is_sale_with_outward = true)
  in_outward?: MisaInOutwardDto;

  // Invoice info (khi include_invoice = 1)
  sa_invoice?: MisaSaInvoiceDto;

  // Audit fields
  created_date?: string;
  created_by?: string;
  modified_date?: string;
  modified_by?: string;

  // Details
  detail: MisaSaVoucherDetailDto[];
}

/**
 * Thông tin phiếu xuất kho (khi bán hàng kiêm phiếu xuất)
 */
export interface MisaInOutwardDto {
  branch_id: string;
  reftype: number;
  posted_date: string;
  refdate: string;
  in_reforder: string;
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  employee_id?: string;
  employee_code?: string;
  employee_name?: string;
  journal_memo?: string;
}

/**
 * Chi tiết chứng từ bán hàng
 */
export interface MisaSaVoucherDetailDto {
  // Product info
  inventory_item_id?: string;
  inventory_item_code: string;
  inventory_item_name: string;
  inventory_item_type: number;
  description: string;

  // Unit info
  unit_id?: string;
  unit_name: string;
  main_unit_id?: string;
  main_unit_name: string;

  // Quantity
  quantity: number;
  main_quantity: number;
  main_convert_rate: number;

  // Price
  unit_price?: number;
  main_unit_price: number;
  unit_price_after_tax?: number;
  amount_oc: number;
  amount: number;

  // Discount
  discount_rate?: number;
  discount_amount_oc?: number;
  discount_amount?: number;

  // VAT
  vat_rate?: number;
  vat_amount_oc?: number;
  vat_amount?: number;

  // Account info (required for sa_voucher)
  debit_account: string;
  credit_account: string;
  cost_account?: string;

  // Customer info per line (required for TK 131 tracking)
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;

  // Stock info
  stock_id?: string;
  stock_code?: string;
  stock_name?: string;

  // Other
  sort_order: number;
  is_promotion?: boolean;
  is_description?: boolean;
  exchange_rate_operator?: string;
}

/**
 * Response từ API save voucher
 */
export interface MisaSaveVoucherResponseDto {
  Success: boolean;
  ErrorCode?: string;
  ErrorMessage?: string;
  Data?: string;
}

/**
 * Callback data từ Misa sau khi xử lý voucher
 */
export interface MisaCallbackDataDto {
  org_refid: string;
  status: 'success' | 'failed';
  voucher_id?: string;
  voucher_no?: string;
  error_code?: string;
  error_message?: string;
  created_date?: string;
}

/**
 * Request body callback từ Misa
 */
export interface MisaCallbackRequestDto {
  app_id: string;
  data: MisaCallbackDataDto[];
}

/**
 * Request body để xóa chứng từ
 */
export interface MisaDeleteVoucherRequestDto {
  app_id: string;
  org_company_code: string;
  voucher: MisaDeleteVoucherItemDto[];
}

/**
 * Item trong danh sách voucher cần xóa
 */
export interface MisaDeleteVoucherItemDto {
  voucher_type: number;
  org_refid: string;
}

/**
 * Response từ API delete voucher
 */
export interface MisaDeleteVoucherResponseDto {
  Success: boolean;
  ErrorCode?: string;
  ErrorMessage?: string;
}

/**
 * Thông tin hóa đơn đính kèm (sa_invoice trong sa_voucher)
 */
export interface MisaSaInvoiceDto {
  reftype: number;
  inv_date: string;
  inv_no?: string;
  inv_series?: string;
  inv_template_no?: string;
  inv_type_id: number;
  branch_id: string;

  // Customer info
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  account_object_tax_code?: string;

  // Employee info
  employee_id?: string;
  employee_code?: string;
  employee_name?: string;

  // Other
  exchange_rate?: number;
  currency_id?: string;
  discount_type?: number;
  discount_rate_voucher?: number;
  payment_method?: string;
  buyer?: string;
  is_paid?: boolean;
  is_posted?: boolean;

  // Totals
  total_sale_amount_oc?: number;
  total_sale_amount?: number;
  total_amount_oc?: number;
  total_amount?: number;
  total_discount_amount_oc?: number;
  total_discount_amount?: number;
  total_vat_amount_oc?: number;
  total_vat_amount?: number;

  // Details
  detail: MisaSaInvoiceDetailDto[];
}

/**
 * Chi tiết hóa đơn đính kèm
 */
export interface MisaSaInvoiceDetailDto {
  inventory_item_id?: string;
  inventory_item_code: string;
  inventory_item_name: string;
  inventory_item_type: number;
  description: string;

  unit_id?: string;
  unit_name: string;
  main_unit_id?: string;
  main_unit_name: string;

  quantity: number;
  main_quantity: number;
  main_convert_rate: number;

  unit_price: number;
  main_unit_price: number;
  amount_oc: number;
  amount: number;
  amount_after_tax?: number;

  discount_rate?: number;
  discount_amount_oc?: number;
  discount_amount?: number;

  vat_rate?: number;
  vat_amount_oc?: number;
  vat_amount?: number;

  debit_account: string;
  credit_account: string;
  sale_account?: string;

  // Customer info per line
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;

  stock_id?: string;
  stock_code?: string;
  stock_name?: string;

  sort_order: number;
  exchange_rate_operator?: string;
  is_description?: boolean;
}
