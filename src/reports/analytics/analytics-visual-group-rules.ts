import { Prisma } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════════════════
// Quy tắc "Nhóm hàng hiển thị" (1.Boduo, 2.Trong nước…) — thay cột tính DAX
// dim_product[visual_product_group] của Power BI bằng bảng sửa được trong
// Cấu hình › Nhóm hàng hiển thị (bảng analytics_product_visual_groups).
//   • Xét theo "Thứ tự" (priority) tăng dần; sản phẩm khớp quy tắc đầu tiên thì
//     lấy nhóm của quy tắc đó; không khớp quy tắc nào → "Khác".
//   • Điều kiện để trống = không xét. Loại hàng / nguồn gốc / thương hiệu / danh
//     mục so khớp không phân biệt hoa thường; mã hàng đúng từng ký tự; "tên chứa"
//     là chứa chuỗi (không phân biệt hoa thường).
//   • report_scope: null = mọi báo cáo; 'sale' = bản dataset_sale (Kinh Doanh,
//     Định Kì, Khách Hàng, Quản Trị…); 'purchasing' = bản dataset_purchasing
//     (Thu Mua, Chuyển Kho).
// ═══════════════════════════════════════════════════════════════════════════

export const VISUAL_GROUP_SCOPES = ['sale', 'purchasing'] as const;
export type VisualGroupScope = (typeof VISUAL_GROUP_SCOPES)[number];

export interface VisualGroupRuleInput {
  priority: number;
  productCode?: string | null;
  productType?: string | null;
  origin?: string | null;
  brand?: string | null;
  category?: string | null;
  nameContains?: string | null;
  reportScope?: VisualGroupScope | null;
  visualGroup: string;
}

/**
 * Quy tắc gốc của Power BI (trước đây viết cứng trong SQL), nạp sẵn khi bảng trống
 * (backend tự nạp khi khởi động nếu bảng trống). Thứ tự cách 10 để chèn quy tắc mới vào giữa.
 */
export const DEFAULT_VISUAL_GROUP_RULES: VisualGroupRuleInput[] = [
  {
    priority: 10,
    productType: 'Hàng thương mại',
    brand: 'Boduo',
    visualGroup: '1.Boduo',
  },
  // Chỉ bản dataset_sale: CONTAINSSTRING(dim_product[name], "Boduo").
  {
    priority: 20,
    nameContains: 'Boduo',
    reportScope: 'sale',
    visualGroup: '1.Boduo',
  },
  {
    priority: 30,
    productType: 'Hàng thương hiệu',
    brand: 'Lermao',
    visualGroup: '4.Lermao',
  },
  {
    priority: 40,
    productType: 'Hàng thương hiệu',
    brand: 'Phượng Hoàng',
    visualGroup: '5.Phượng Hoàng',
  },
  { priority: 50, productType: 'Hàng thương hiệu', visualGroup: '3.Nhập khẩu' },
  {
    priority: 60,
    productType: 'Hàng thương mại',
    brand: 'Western',
    visualGroup: '6.Sữa tươi',
  },
  { priority: 70, productType: 'Hàng OEM', visualGroup: '8.OEM - Khác' },
  {
    priority: 80,
    productType: 'Hàng thương mại',
    origin: 'Nhập khẩu Chính Ngạch',
    visualGroup: '3.Nhập khẩu',
  },
  {
    priority: 81,
    productType: 'Hàng thương mại',
    origin: 'Nhập khẩu khác',
    visualGroup: '3.Nhập khẩu',
  },
  {
    priority: 90,
    productType: 'Hàng thương mại',
    origin: 'Nội địa',
    visualGroup: '2.Trong nước',
  },
];

/**
 * LEFT JOIN LATERAL lấy quy tắc khớp đầu tiên cho mỗi sản phẩm (alias p = products,
 * tm = trade_marks) → alias vg. Dùng cùng VISUAL_GROUP_EXPR.
 */
export function visualGroupLateral(scope: VisualGroupScope): Prisma.Sql {
  return Prisma.sql`LEFT JOIN LATERAL (
          SELECT r.visual_group
          FROM analytics_product_visual_groups r
          WHERE (r.report_scope IS NULL OR r.report_scope = ${scope})
            AND (r.product_code IS NULL OR r.product_code = p.code)
            AND (r.product_type IS NULL OR lower(r.product_type) = lower(p.parent_name))
            AND (r.origin IS NULL OR lower(r.origin) = lower(p.middle_name))
            AND (r.brand IS NULL OR lower(r.brand) = lower(tm.name))
            AND (r.category IS NULL OR lower(r.category) = lower(p.child_name))
            AND (r.name_contains IS NULL OR strpos(lower(p.name), lower(r.name_contains)) > 0)
          ORDER BY r.priority, r.id
          LIMIT 1
        ) vg ON true`;
}

/** Nhóm hiển thị của sản phẩm (cần visualGroupLateral trong FROM). */
export const VISUAL_GROUP_EXPR = Prisma.sql`COALESCE(vg.visual_group, 'Khác')`;
