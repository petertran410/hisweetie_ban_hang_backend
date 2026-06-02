/**
 * Request body để lấy danh mục từ Misa
 */
export interface MisaGetDictionaryRequestDto {
  data_type: number;
  skip: number;
  take: number;
  app_id: string;
  last_sync_time?: string;
}

/**
 * Response chung từ API get_dictionary
 * Lưu ý: Data từ Misa trả về dạng JSON string, không phải array trực tiếp
 */
export interface MisaGetDictionaryResponseDto<T> {
  Success: boolean;
  ErrorCode?: string;
  ErrorMessage?: string;
  Data?: string | T[];
}

/**
 * Inventory Item từ Misa (data_type = 2)
 */
export interface MisaInventoryItemDto {
  dictionary_type: number;
  inventory_item_id: string;
  inventory_item_code: string;
  inventory_item_name: string;
  inventory_item_type: number;
  unit_id?: string;
  unit_name?: string;
  unit_list?: string;
  default_stock_id?: string;
  branch_id?: string;
  unit_price?: number;
  sale_price1?: number;
  sale_price2?: number;
  sale_price3?: number;
  inactive?: boolean;
  inventory_account?: string;
  cogs_account?: string;
  sale_account?: string;
  discount_account?: string;
  created_date?: string;
  modified_date?: string;
}

/**
 * Stock từ Misa (data_type = 3)
 */
export interface MisaStockDto {
  dictionary_type: number;
  stock_id: string;
  stock_code: string;
  stock_name: string;
  branch_id?: string;
  inactive?: boolean;
  inventory_account?: string;
  description?: string;
  created_date?: string;
  modified_date?: string;
}

/**
 * Account Object từ Misa (data_type = 1)
 */
export interface MisaAccountObjectDto {
  dictionary_type: number;
  account_object_id: string;
  account_object_code: string;
  account_object_name: string;
  account_object_type?: number;
  address?: string;
  ward_or_commune?: string;
  province_or_city?: string;
  country?: string;
  company_tax_code?: string;
  branch_id?: string;
  is_customer?: boolean;
  is_vendor?: boolean;
  is_employee?: boolean;
  inactive?: boolean;
  pay_account?: string;
  receive_account?: string;
  created_date?: string;
  modified_date?: string;
}

/**
 * Organization Unit từ Misa (data_type = 6)
 */
export interface MisaOrganizationUnitDto {
  organization_unit_id: string;
  organization_unit_code: string;
  organization_unit_name: string;
  organization_unit_type_id: number;
  parent_id?: string;
  branch_id?: string;
}
