import { searchProductIds } from '../../common/product-search.util';
import { str, type AiTool } from './common';
import { bool, limitOf, limitParameter, listMeta, money } from './tool-helpers';

/** Số sản phẩm tối đa khớp từ khoá đem đi tra tồn. */
const MAX_PRODUCTS = 200;

const qty = (value: unknown) => Number(value ?? 0);

/** Trường dùng tới của một dòng tồn (getInventoryByBranch / getLowStockProducts). */
interface StockRow {
  productCode: string;
  productName: string;
  branchName: string;
  cost: unknown;
  onHand: unknown;
  reserved: unknown;
  onOrder: unknown;
  minQuality: unknown;
  damagedQuantity: unknown;
  nearExpiryQuantity: unknown;
  promoQuantity: unknown;
  product?: {
    code: string;
    name: string;
    basePrice: unknown;
    unit?: string | null;
    isActive?: boolean;
  } | null;
  branch?: { name: string } | null;
}

export const stockLevelsTool: AiTool = {
  name: 'stock_levels',
  label: 'Đang xem tồn kho',
  description: (scope) =>
    `Tồn kho tại chi nhánh đang chọn trên POS: tìm theo tên / mã sản phẩm, hoặc bỏ trống để xem các sản phẩm sắp hết / hết hàng (tồn ≤ tồn tối thiểu). Mỗi dòng: mã, tên, đơn vị, tồn, khách đặt, đang về, tồn tối thiểu, hàng bục rách / cận date / khuyến mãi, giá bán${
      scope.can('products:view_cost_price') ? ', giá vốn' : ''
    }.`,
  parameters: {
    type: 'object',
    properties: {
      product: {
        type: 'string',
        description: 'Tên hoặc mã sản phẩm. Bỏ trống = danh sách sắp hết hàng.',
      },
      lowStockOnly: {
        type: 'boolean',
        description:
          'Khi có tìm sản phẩm: true = chỉ giữ dòng tồn ≤ tồn tối thiểu.',
      },
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) =>
    scope.can('inventory:view') || scope.can('products:view'),
  async run({ scope, deps }, args) {
    const branchId = scope.branchId ?? scope.user.branchId;
    if (!branchId)
      return { error: 'no_branch: hãy chọn chi nhánh trên POS rồi hỏi lại' };
    const limit = limitOf(args);
    const canViewCost = scope.can('products:view_cost_price');
    const term = str(args, 'product');

    let rows: StockRow[];
    if (term) {
      const ids = (await searchProductIds(deps.prisma, term)).slice(
        0,
        MAX_PRODUCTS,
      );
      // Mảng rỗng = service trả cả chi nhánh → dừng sớm.
      rows = ids.length
        ? await deps.inventories.getInventoryByBranch(branchId, ids)
        : [];
      rows = rows.filter((row) => row.product?.isActive !== false);
      if (bool(args, 'lowStockOnly'))
        rows = rows.filter((row) => qty(row.onHand) <= qty(row.minQuality));
    } else {
      rows = (
        (await deps.inventories.getLowStockProducts(branchId)) as StockRow[]
      ).sort((a, b) => qty(a.onHand) - qty(b.onHand));
    }

    const items = rows.slice(0, limit).map((row) => ({
      code: row.product?.code ?? row.productCode,
      name: row.product?.name ?? row.productName,
      unit: row.product?.unit ?? null,
      onHand: qty(row.onHand),
      reserved: qty(row.reserved),
      onOrder: qty(row.onOrder),
      minQuantity: qty(row.minQuality),
      damaged: qty(row.damagedQuantity),
      nearExpiry: qty(row.nearExpiryQuantity),
      promo: qty(row.promoQuantity),
      basePrice: money(row.product?.basePrice),
      ...(canViewCost ? { cost: money(row.cost) } : {}),
    }));

    return {
      branch: rows[0]?.branch?.name ?? rows[0]?.branchName ?? null,
      mode: term ? `Tìm "${term}"` : 'Sắp hết / hết hàng (tồn ≤ tồn tối thiểu)',
      items,
      ...listMeta(items.length, rows.length),
      ...(items.length === 0
        ? {
            note: term
              ? 'Không có sản phẩm khớp tại chi nhánh này.'
              : 'Không có sản phẩm sắp hết hàng.',
          }
        : {}),
    };
  },
};
