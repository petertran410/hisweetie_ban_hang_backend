import { SetMetadata } from '@nestjs/common';

// Metadata key cho ReportsPermissionGuard.
export const REPORT_PERMISSION_KEY = 'reportPermission';

// Nhóm báo cáo dùng để suy quyền động theo query.viewType.
export type ReportGroup = 'sale' | 'product' | 'supplier' | 'eod' | 'customer';

export interface ReportPermissionConfig {
  // Nhóm có nhiều ViewType → guard dựng key xem từ viewType.
  group?: ReportGroup;
  // Key xem cố định (route customer-* và financial) → guard kiểm tra trực tiếp.
  key?: string;
  // Nếu set: đây là endpoint XUẤT EXCEL, cần THÊM quyền export theo nhóm.
  // Guard kiểm tra cả quyền xem (group/key) lẫn exportKey này.
  exportKey?: string;
}

/**
 * Gắn quyền cho route báo cáo.
 * - `@ReportPermission({ group: 'sale' })`  → key xem suy từ query.viewType.
 * - `@ReportPermission({ key: 'reports:financial' })` → key xem cố định.
 * - Thêm `exportKey: 'reports:export_sale'` cho endpoint xuất Excel → cần cả
 *   quyền xem (đúng loại) lẫn quyền xuất nhóm.
 */
export const ReportPermission = (config: ReportPermissionConfig) =>
  SetMetadata(REPORT_PERMISSION_KEY, config);
