// ====================================================================
// PHẠM VI KHÁCH HÀNG CỦA BẢNG GIÁ — dùng chung cho:
// - GET /customers/search?priceBookId=…  (POS chỉ tìm khách thuộc bảng giá)
// - GET /price-books/applicable?customerId=…  (khách được dùng bảng giá nào)
//
// Quy tắc:
// - Bảng giá "riêng": có nhóm khách cụ thể và/hoặc khách cụ thể. Khách thuộc
//   bảng giá riêng nếu có tên trong danh sách khách HOẶC thuộc một nhóm đã chọn.
// - Bảng giá "mở" (nhóm + khách đều "Tất cả") và Bảng giá chung: chỉ dành cho
//   khách CHƯA gắn vào bảng giá riêng nào đang chọn được (cùng chi nhánh,
//   người dùng, còn hạn) — nhờ vậy khách luôn tìm được qua một lựa chọn nào đó.
// - forAll = false mà danh sách rỗng được coi là "Tất cả", giống form
//   Thiết lập giá.
// ====================================================================

import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PriceBookContext {
  branchId?: number;
  userId?: number;
  date?: Date;
}

// Điều kiện bảng giá chọn được trong ngữ cảnh hiện tại (chưa xét khách).
export function selectablePriceBookWhere(ctx: PriceBookContext): {
  isActive: true;
  AND: Prisma.PriceBookWhereInput[];
} {
  const checkDate = ctx.date ?? new Date();
  const and: Prisma.PriceBookWhereInput[] = [
    { OR: [{ startDate: null }, { startDate: { lte: checkDate } }] },
    { OR: [{ endDate: null }, { endDate: { gte: checkDate } }] },
  ];
  if (ctx.branchId) {
    and.push({
      OR: [
        { isGlobal: true },
        { priceBookBranches: { some: { branchId: ctx.branchId } } },
      ],
    });
  }
  if (ctx.userId) {
    and.push({
      OR: [
        { forAllUser: true },
        { priceBookUsers: { some: { userId: ctx.userId } } },
      ],
    });
  }
  return { isActive: true, AND: and };
}

export interface PriceBookScopeRow {
  id: number;
  forAllCusGroup: boolean;
  forAllCustomer: boolean;
  priceBookCustomerGroups: { customerGroupId: number }[];
  priceBookCustomers: { customerId: number }[];
}

export const priceBookScopeSelect = {
  id: true,
  forAllCusGroup: true,
  forAllCustomer: true,
  priceBookCustomerGroups: { select: { customerGroupId: true } },
  priceBookCustomers: { select: { customerId: true } },
} satisfies Prisma.PriceBookSelect;

export function getCustomerScope(pb: PriceBookScopeRow) {
  const groupIds = pb.forAllCusGroup
    ? []
    : pb.priceBookCustomerGroups.map((g) => g.customerGroupId);
  const customerIds = pb.forAllCustomer
    ? []
    : pb.priceBookCustomers.map((c) => c.customerId);
  return {
    groupIds,
    customerIds,
    restricted: groupIds.length > 0 || customerIds.length > 0,
  };
}

export function isRestrictedPriceBook(pb: PriceBookScopeRow) {
  return getCustomerScope(pb).restricted;
}

export function customerBelongsToPriceBook(
  pb: PriceBookScopeRow,
  customerId: number,
  customerGroupIds: number[],
) {
  const scope = getCustomerScope(pb);
  if (!scope.restricted) return false;
  return (
    scope.customerIds.includes(customerId) ||
    scope.groupIds.some((g) => customerGroupIds.includes(g))
  );
}

// Lọc danh sách bảng giá (đã chọn được trong ngữ cảnh) còn lại những bảng giá
// khách được dùng: bảng giá riêng khách thuộc; nếu không thuộc bảng giá riêng
// nào thì là các bảng giá mở.
export function filterPriceBooksForCustomer<T extends PriceBookScopeRow>(
  priceBooks: T[],
  customerId: number,
  customerGroupIds: number[],
): T[] {
  const own = priceBooks.filter((pb) =>
    customerBelongsToPriceBook(pb, customerId, customerGroupIds),
  );
  if (own.length > 0) return own;
  return priceBooks.filter((pb) => !isRestrictedPriceBook(pb));
}

// Điều kiện khách thuộc phạm vi (danh sách khách HOẶC nhóm khách).
function scopeCustomerWhere(
  priceBookIdsWithCustomers: number[],
  groupIds: number[],
): Prisma.CustomerWhereInput[] {
  const or: Prisma.CustomerWhereInput[] = [];
  if (priceBookIdsWithCustomers.length > 0) {
    or.push({
      priceBookCustomers: {
        some: { priceBookId: { in: priceBookIdsWithCustomers } },
      },
    });
  }
  if (groupIds.length > 0) {
    or.push({
      customerGroupDetails: { some: { customerGroupId: { in: groupIds } } },
    });
  }
  return or;
}

// Điều kiện Prisma cho khách hàng tìm được khi đang chọn `priceBookId`
// (0 = Bảng giá chung).
export async function buildCustomerWhereForPriceBook(
  prisma: PrismaService,
  priceBookId: number,
  ctx: PriceBookContext,
): Promise<Prisma.CustomerWhereInput> {
  if (priceBookId > 0) {
    const pb = await prisma.priceBook.findUnique({
      where: { id: priceBookId },
      select: priceBookScopeSelect,
    });
    if (pb) {
      const scope = getCustomerScope(pb);
      if (scope.restricted) {
        return {
          OR: scopeCustomerWhere(
            scope.customerIds.length > 0 ? [pb.id] : [],
            scope.groupIds,
          ),
        };
      }
    }
    // Bảng giá mở → xử lý như Bảng giá chung.
  }

  const priceBooks = await prisma.priceBook.findMany({
    where: selectablePriceBookWhere(ctx),
    select: priceBookScopeSelect,
  });

  const pbIdsWithCustomers: number[] = [];
  const groupIds = new Set<number>();
  for (const pb of priceBooks) {
    const scope = getCustomerScope(pb);
    if (scope.customerIds.length > 0) pbIdsWithCustomers.push(pb.id);
    scope.groupIds.forEach((g) => groupIds.add(g));
  }

  const assigned = scopeCustomerWhere(pbIdsWithCustomers, [...groupIds]);
  if (assigned.length === 0) return {};
  return { NOT: { OR: assigned } };
}
