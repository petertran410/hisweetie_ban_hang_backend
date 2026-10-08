/**
 * Request body để tạo chứng từ bán hàng
 */
export interface MisaSaveVoucherRequestDto {
  org_company_code: string;
  voucher: MisaSaVoucherDto[];
}

/**
 * Chứng từ bán hàng OpenAPI AMIS (voucher_type = 13).
 * Chứng từ có thể kèm phiếu xuất kho và hóa đơn bán hàng.
 */
export interface MisaSaVoucherDto {
  voucher_type: number;
  org_refid: string;
  org_refcode?: string;
  org_refno: string;
  org_reftype?: number | null;
  org_reftype_name?: string;
  branch_id: string;
  inv_refid?: string;
  in_outward_refid?: string;
  reftype: number;
  reftype_name?: string;
  posted_date: string;
  refdate: string;
  is_sale_with_outward: boolean;

  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  account_object_tax_code?: string;

  employee_id?: string;
  employee_code?: string;
  employee_name?: string;

  discount_type?: number;
  discount_rate_voucher?: number;
  exchange_rate?: number;
  currency_id?: string;
  include_invoice?: number;
  payer?: string;
  journal_memo?: string;

  total_sale_amount_oc: number;
  total_sale_amount: number;
  total_amount_oc: number;
  total_amount: number;
  total_discount_amount_oc: number;
  total_discount_amount: number;
  total_vat_amount_oc: number;
  total_vat_amount: number;

  in_outward?: MisaInOutwardDto;
  sa_invoice?: MisaSaInvoiceDto;

  created_date?: string;
  created_by?: string;
  modified_date?: string;
  modified_by?: string;

  detail: MisaSaInvoiceDetailDto[];
}

export interface MisaInOutwardDto {
  refid?: string;
  branch_id: string;
  reftype: number;
  reftype_name?: string;
  posted_date: string;
  refdate: string;
  in_reforder: string;
  refno_finance?: string;
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  employee_id?: string;
  employee_code?: string;
  employee_name?: string;
  journal_memo?: string;
}

export interface MisaSaInvoiceDto {
  reftype: number;
  inv_date: string;
  inv_no?: string;
  inv_series?: string;
  inv_template_no?: string;
  inv_type_id: number;
  branch_id: string;
  account_object_id?: string;
  account_object_code?: string;
  account_object_name?: string;
  account_object_address?: string;
  account_object_tax_code?: string;
  employee_id?: string;
  employee_code?: string;
  employee_name?: string;
  exchange_rate?: number;
  currency_id?: string;
  discount_type?: number;
  discount_rate_voucher?: number;
  payment_method?: string;
  buyer?: string;
  is_paid?: boolean;
  is_posted?: boolean;
  total_sale_amount_oc?: number;
  total_sale_amount?: number;
  total_amount_oc?: number;
  total_amount?: number;
  total_discount_amount_oc?: number;
  total_discount_amount?: number;
  total_vat_amount_oc?: number;
  total_vat_amount?: number;
  detail: MisaSaInvoiceDetailDto[];
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
  success?: boolean;
  status?: 'success' | 'failed';
  voucher_id?: string;
  voucher_no?: string;
  error_code?: string;
  error_message?: string;
  session_id?: string;
  voucher_type?: number;
  created_date?: string;
}

/**
 * Request body callback từ Misa
 */
export interface MisaCallbackRequestDto {
  app_id?: string;
  success?: boolean;
  error_message?: string;
  signature?: string;
  data_type?: number;
  org_company_code?: string;
  data: string | MisaCallbackDataDto[];
}

/**
 * Request body để xóa chứng từ
 */
export interface MisaDeleteVoucherRequestDto {
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
