/**
 * Quan hệ sản phẩm × nhà máy — nguồn chân lý duy nhất là `factory_products`.
 *
 * Một sản phẩm gắn được **nhiều** nhà máy chính và **nhiều** nhà máy backup.
 * Một nhà máy chỉ giữ đúng một vai trò với một sản phẩm (ràng buộc
 * `@@unique([factoryId, productId])`).
 *
 * Hai cột `Product.primaryFactoryId` / `backupFactoryId` đã bị loại bỏ.
 */

type Tx = {
  factory_products: {
    findMany: (args: any) => Promise<any[]>;
    findUnique: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    delete: (args: any) => Promise<any>;
  };
  factoryChangeLog: {
    createMany: (args: any) => Promise<any>;
  };
  user: {
    findUnique: (args: any) => Promise<any>;
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

export const FACTORY_PRODUCTS_INCLUDE = {
  factory_products: {
    where: { isActive: true },
    orderBy: MAPPING_ORDER,
    include: { factories: { select: FACTORY_SELECT } },
  },
} as const;

export type MappingRole = 'primary' | 'backup';

/** Một dòng mapping do form sản phẩm gửi lên. */
export interface DesiredMapping {
  factoryId: number;
  role: MappingRole;
  priority?: number;
}

/**
 * Chuẩn hoá `factory_products` thành `factoryMappings` cho FE.
 *
 * Giữ **toàn bộ** dòng, không cắt bớt — đây là điểm khác biệt so với mô hình
 * 2 cột cũ vốn chỉ diễn tả được 1 chính + 1 backup.
 */
export function overlayFactoriesFromMappings<T extends Record<string, any>>(
  product: T,
): T & { factoryMappings: any[] } {
  const raw: any[] = Array.isArray(product.factory_products)
    ? product.factory_products
    : [];

  const factoryMappings = raw.map((row) => ({
    id: row.id,
    factoryId: row.factoryId,
    role: row.role === 'backup' ? 'backup' : 'primary',
    priority: row.priority ?? 0,
    isActive: row.isActive !== false,
    referencePrice:
      row.referencePrice == null ? null : Number(row.referencePrice),
    currency: row.currency ?? null,
    exchangeRate: row.exchangeRate == null ? null : Number(row.exchangeRate),
    moq: row.moq == null ? null : Number(row.moq),
    moqValue: row.moqValue == null ? null : Number(row.moqValue),
    moqBasis: row.moqBasis ?? null,
    moqUnit: row.moqUnit ?? null,
    moqIncrement: row.moqIncrement == null ? null : Number(row.moqIncrement),
    leadtimeDays: row.leadtimeDays ?? null,
    note: row.note ?? null,
    factory: row.factories ?? null,
  }));

  return { ...product, factoryMappings };
}

/** Một sự kiện thay đổi mapping, ghi vào `factory_change_logs`. */
export interface MappingChangeEvent {
  productId: number;
  factoryId: number;
  action: 'attach' | 'detach' | 'role_change' | 'priority_change';
  previousRole: MappingRole | null;
  role: MappingRole | null;
  previousPriority: number | null;
  priority: number | null;
}

/** Ghi log sự kiện. Bỏ qua khi không xác định được người thao tác. */
export async function writeMappingChangeLogs(
  tx: Tx,
  args: {
    events: MappingChangeEvent[];
    userId?: number | null;
    userName?: string | null;
    reason?: string | null;
  },
) {
  if (!args.events.length || !args.userId) return;

  // Lưu tên tại thời điểm thao tác để log vẫn đọc được nếu user đổi tên/nghỉ.
  let changedByName = args.userName ?? null;
  if (!changedByName) {
    const user = await tx.user.findUnique({
      where: { id: args.userId },
      select: { name: true },
    });
    changedByName = user?.name ?? null;
  }

  await tx.factoryChangeLog.createMany({
    data: args.events.map((event) => ({
      productId: event.productId,
      factoryId: event.factoryId,
      action: event.action,
      previousRole: event.previousRole,
      role: event.role,
      previousPriority: event.previousPriority,
      priority: event.priority,
      changedById: args.userId as number,
      changedByName,
      reason: args.reason ?? null,
    })),
  });
}

/**
 * Đồng bộ toàn bộ danh sách nhà máy của một sản phẩm (replace-set).
 *
 * - Nhà máy mới → tạo mapping (`attach`).
 * - Nhà máy đã có → chỉ đổi `role`/`priority`, **giữ nguyên** giá, MOQ,
 *   leadtime, ghi chú (thuộc quyền trang nhà máy).
 * - Nhà máy không còn trong danh sách → xoá (`detach`).
 *
 * Trả về danh sách sự kiện để nơi gọi ghi log trong cùng transaction.
 */
export async function replaceProductMappings(
  tx: Tx,
  args: {
    productId: number;
    desired: DesiredMapping[];
    userId?: number | null;
    userName?: string | null;
    reason?: string | null;
  },
): Promise<MappingChangeEvent[]> {
  // Một nhà máy chỉ giữ một vai trò với một sản phẩm.
  const seen = new Map<number, DesiredMapping>();
  for (const item of args.desired) {
    if (seen.has(item.factoryId)) continue;
    seen.set(item.factoryId, item);
  }

  const current = await tx.factory_products.findMany({
    where: { productId: args.productId },
    select: { id: true, factoryId: true, role: true, priority: true },
  });
  const currentByFactory = new Map(current.map((row) => [row.factoryId, row]));
  const events: MappingChangeEvent[] = [];

  for (const [factoryId, item] of seen) {
    const existing = currentByFactory.get(factoryId);
    const priority = item.priority ?? 0;

    if (!existing) {
      await tx.factory_products.create({
        data: {
          factoryId,
          productId: args.productId,
          role: item.role,
          priority,
          currency: 'VND',
          isActive: true,
          createdBy: args.userId ?? null,
          updatedAt: new Date(),
        },
      });
      events.push({
        productId: args.productId,
        factoryId,
        action: 'attach',
        previousRole: null,
        role: item.role,
        previousPriority: null,
        priority,
      });
      continue;
    }

    const roleChanged = existing.role !== item.role;
    const priorityChanged = existing.priority !== priority;
    if (!roleChanged && !priorityChanged) continue;

    await tx.factory_products.update({
      where: { id: existing.id },
      data: { role: item.role, priority, isActive: true },
    });
    events.push({
      productId: args.productId,
      factoryId,
      action: roleChanged ? 'role_change' : 'priority_change',
      previousRole: existing.role === 'backup' ? 'backup' : 'primary',
      role: item.role,
      previousPriority: existing.priority ?? null,
      priority,
    });
  }

  for (const row of current) {
    if (seen.has(row.factoryId)) continue;
    await tx.factory_products.delete({ where: { id: row.id } });
    events.push({
      productId: args.productId,
      factoryId: row.factoryId,
      action: 'detach',
      previousRole: row.role === 'backup' ? 'backup' : 'primary',
      role: null,
      previousPriority: row.priority ?? null,
      priority: null,
    });
  }

  await writeMappingChangeLogs(tx, {
    events,
    userId: args.userId,
    userName: args.userName,
    reason: args.reason,
  });

  return events;
}
