import type { CustomerQueryDto } from '../../customers/dto/customer-query.dto';
import { str, type AiTool } from './common';
import { day, limitOf, limitParameter, listMeta, money } from './tool-helpers';

/** Có khi gọi findAll với includeCustomerGroup (kiểu trả về không thể hiện). */
const groupNames = (row: object) =>
  (
    (row as { customerGroupDetails?: { customerGroup?: { name: string } }[] })
      .customerGroupDetails ?? []
  )
    .map((detail) => detail.customerGroup?.name)
    .filter((name): name is string => !!name);

export const customerLookupTool: AiTool = {
  name: 'customer_lookup',
  label: 'Đang tìm khách hàng',
  description: (scope) =>
    `Tìm khách hàng theo tên, mã (KH…) hoặc SĐT: mã, tên, công ty, loại khách, nhóm khách, chi nhánh, Sale PIC, tổng bán, tổng bán trừ trả hàng${
      scope.can('customers:view_debt') ? ', công nợ hiện tại' : ''
    }, trạng thái hoạt động. Không trả SĐT, địa chỉ, email.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Tên, mã khách (KH…) hoặc SĐT cần tìm.',
      },
      includeInactive: {
        type: 'boolean',
        description: 'true = tìm cả khách đã ngừng hoạt động.',
      },
      limit: limitParameter,
    },
    required: ['query'],
    additionalProperties: false,
  },
  available: (scope) => scope.can('customers:view'),
  async run({ scope, deps }, args) {
    const term = str(args, 'query');
    if (!term) return { error: 'missing_query: cần tên, mã hoặc SĐT khách' };
    const limit = limitOf(args, 5);
    const canViewDebt = scope.can('customers:view_debt');

    const list = await deps.customers.findAll(
      {
        name: term,
        pageSize: limit,
        currentItem: 0,
        orderBy: 'totalPurchased',
        orderDirection: 'desc',
        includeCustomerGroup: true,
        ...(args.includeInactive === true ? { includeInactive: true } : {}),
      } as CustomerQueryDto,
      scope.userId,
    );

    // Đúng mã khách thì đưa lên đầu.
    const rows = [...list.data].sort(
      (a, b) =>
        Number(b.code?.toUpperCase() === term.toUpperCase()) -
        Number(a.code?.toUpperCase() === term.toUpperCase()),
    );

    const salePicIds = await Promise.all(
      rows.map((row) => deps.customers.getSalePic(row.id)),
    );
    const picIds = [
      ...new Set(
        salePicIds
          .map((pic) => pic.salePicId)
          .filter((id): id is number => !!id),
      ),
    ];
    const users = picIds.length
      ? await deps.prisma.user.findMany({
          where: { id: { in: picIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(users.map((user) => [user.id, user.name]));

    const customers = rows.map((row, index) => {
      const picId = salePicIds[index]?.salePicId;
      return {
        code: row.code,
        name: row.name,
        organization: row.organization ?? null,
        customerType: row.customerType?.name ?? null,
        groups: groupNames(row),
        branch: row.branch?.name ?? null,
        salePic: picId ? (nameOf.get(picId) ?? null) : null,
        totalPurchased: money(row.totalPurchased),
        totalRevenue: money(row.totalRevenue),
        ...(canViewDebt ? { currentDebt: money(row.totalDebt) } : {}),
        isActive: row.isActive,
        createdAt: day(row.createdAt),
      };
    });

    return {
      query: term,
      customers,
      ...listMeta(customers.length, list.total),
      ...(customers.length === 0
        ? { note: 'Không tìm thấy khách hàng phù hợp.' }
        : {}),
    };
  },
};
