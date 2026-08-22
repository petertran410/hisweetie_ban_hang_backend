/**
 * Cầu nối giữa hai nguồn dữ liệu nhà máy × sản phẩm:
 *
 *  1. `factory_products` — mapping M:N, nguồn chân lý mới (giá, MOQ, LT).
 *  2. `Product.primaryFactoryId` / `backupFactoryId` — 2 cột cũ, form sản phẩm
 *     và một số filter/báo cáo vẫn đọc.
 *
 * Form sản phẩm chỉ hiển thị 1 nhà máy chính + 1 backup. Khi mapping có nhiều
 * dòng cùng role, lấy dòng `priority` thấp nhất (ưu tiên cao nhất), tie-break
 * theo `id` tăng dần.
 */

type Tx = {
  factory_products: {
    findMany: (args: any) => Promise<any[]>;
    findUnique: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    delete: (args: any) => Promise<any>;
  };
  product: {
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
};

export const FACTORY_SELECT = {
  id: true,
  code: true,
  name: true,
  country: true,
  currency: true,
} as const;

const MAPPING_ORDER = [{ priority: 'asc' as const }, { id: 'asc' as const }];

export function pickFactoryByRole(
  mappings: Array<{
    role: string;
    isActive?: boolean;
    factories?: unknown;
  }>,
  role: 'primary' | 'backup',
) {
  const row = mappings.find(
    (item) => item.role === role && item.isActive !== false,
  );
  return row?.factories ?? null;
}

/**
 * Ghi đè `primaryFactoryId` / `backupFactoryId` (và object quan hệ) từ mapping.
 * Cột cũ vẫn thắng nếu mapping chưa có dòng tương ứng — tránh làm mất dữ liệu
 * lịch sử chưa được backfill.
 */
export function overlayFactoriesFromMappings<T extends Record<string, any>>(
  product: T,
): T {
  const mappings: any[] = Array.isArray(product.factory_products)
    ? product.factory_products
    : [];
  if (!mappings.length) return product;

  const primary = pickFactoryByRole(mappings, 'primary') as {
    id: number;
  } | null;
  const backup = pickFactoryByRole(mappings, 'backup') as { id: number } | null;

  return {
    ...product,
    primaryFactoryId: primary?.id ?? product.primaryFactoryId ?? null,
    backupFactoryId: backup?.id ?? product.backupFactoryId ?? null,
    primaryFactory: primary ?? product.primaryFactory ?? null,
    backupFactory: backup ?? product.backupFactory ?? null,
  };
}

/**
 * Đảm bảo có đúng 1 dòng mapping `role` cho `factoryId`.
 *
 * - Đã có dòng cùng nhà máy → chỉ cập nhật role (giữ giá/MOQ/LT).
 * - Chưa có → tạo dòng mới, kế thừa currency của nhà máy nếu có.
 * - Dòng khác cùng role (ưu tiên thấp hơn) không bị xóa — trang nhà máy cho
 *   phép nhiều nhà máy cùng role; form sản phẩm chỉ hiện 1 cái.
 */
export async function upsertMappingRole(
  tx: Tx,
  args: {
    productId: number;
    factoryId: number;
    role: 'primary' | 'backup';
    userId?: number | null;
  },
) {
  const existing = await tx.factory_products.findUnique({
    where: {
      factoryId_productId: {
        factoryId: args.factoryId,
        productId: args.productId,
      },
    },
  });

  if (existing) {
    if (existing.role !== args.role || !existing.isActive) {
      await tx.factory_products.update({
        where: { id: existing.id },
        data: { role: args.role, isActive: true },
      });
    }
    return;
  }

  await tx.factory_products.create({
    data: {
      factoryId: args.factoryId,
      productId: args.productId,
      role: args.role,
      priority: 0,
      currency: 'VND',
      isActive: true,
      createdBy: args.userId ?? null,
      updatedAt: new Date(),
    },
  });
}

/**
 * Gỡ mapping `role` của 1 nhà máy khỏi sản phẩm.
 *
 * Chỉ xóa khi dòng hiện đúng `role` đó — tránh xóa nhầm dòng đã được đổi
 * vai trò thành nhà máy kia (trường hợp swap primary ↔ backup).
 */
export async function unlinkMappingRole(
  tx: Tx,
  args: {
    productId: number;
    factoryId: number;
    role: 'primary' | 'backup';
  },
) {
  const existing = await tx.factory_products.findUnique({
    where: {
      factoryId_productId: {
        factoryId: args.factoryId,
        productId: args.productId,
      },
    },
  });
  if (!existing) return;
  if (existing.role !== args.role) return;
  await tx.factory_products.delete({ where: { id: existing.id } });
}

/**
 * Khi gắn/đổi role từ trang nhà máy: đồng bộ cột scalar nếu đang trống
 * hoặc đang trỏ đúng nhà máy này (đổi role → cập nhật cột tương ứng).
 *
 * Không ghi đè cột đang trỏ nhà máy khác — form sản phẩm chỉ hiện 1 nhà máy,
 * ghi đè sẽ làm mất lựa chọn người dùng đã set.
 */
export async function syncProductFactoryColumns(
  tx: Tx,
  args: {
    productId: number;
    factoryId: number;
    role: 'primary' | 'backup';
  },
) {
  const product = await tx.product.findUnique({
    where: { id: args.productId },
    select: { primaryFactoryId: true, backupFactoryId: true },
  });
  if (!product) return;

  const data: Record<string, number | null> = {};
  if (args.role === 'primary') {
    if (
      product.primaryFactoryId == null ||
      product.primaryFactoryId === args.factoryId
    ) {
      data.primaryFactoryId = args.factoryId;
    }
    if (product.backupFactoryId === args.factoryId) {
      data.backupFactoryId = null;
    }
  } else {
    if (
      product.backupFactoryId == null ||
      product.backupFactoryId === args.factoryId
    ) {
      data.backupFactoryId = args.factoryId;
    }
    if (product.primaryFactoryId === args.factoryId) {
      data.primaryFactoryId = null;
    }
  }

  if (Object.keys(data).length === 0) return;
  await tx.product.update({
    where: { id: args.productId },
    data,
  });
}

/**
 * Khi bỏ gắn mapping: xóa cột scalar nếu đang trỏ đúng nhà máy bị gỡ.
 * Nếu còn mapping khác cùng role → chuyển cột sang nhà máy ưu tiên tiếp theo.
 */
export async function clearProductFactoryColumnIfMatches(
  tx: Tx,
  args: {
    productId: number;
    factoryId: number;
    role: 'primary' | 'backup';
  },
) {
  const product = await tx.product.findUnique({
    where: { id: args.productId },
    select: { primaryFactoryId: true, backupFactoryId: true },
  });
  if (!product) return;

  const field =
    args.role === 'primary' ? 'primaryFactoryId' : 'backupFactoryId';
  if (product[field] !== args.factoryId) return;

  const fallback = await tx.factory_products.findMany({
    where: {
      productId: args.productId,
      role: args.role,
      isActive: true,
      factoryId: { not: args.factoryId },
    },
    orderBy: MAPPING_ORDER,
    take: 1,
    select: { factoryId: true },
  });

  await tx.product.update({
    where: { id: args.productId },
    data: { [field]: fallback[0]?.factoryId ?? null },
  });
}

export const FACTORY_PRODUCTS_INCLUDE = {
  factory_products: {
    where: { isActive: true },
    orderBy: MAPPING_ORDER,
    include: { factories: { select: FACTORY_SELECT } },
  },
} as const;
