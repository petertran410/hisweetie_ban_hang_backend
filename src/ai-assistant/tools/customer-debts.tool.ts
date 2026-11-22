import type { DebtTrackingQueryDto } from '../../debt-tracking/dto';
import {
  DEBT_FORM_LABELS,
  DEBT_STATUS_LABELS,
  DEBT_STATUSES,
} from '../../debt-tracking/debt-tracking.constants';
import { str, type AiTool } from './common';
import {
  bool,
  branchOf,
  currentBranchParameter,
  day,
  limitOf,
  limitParameter,
  listMeta,
  money,
} from './tool-helpers';

const ORDER_BY = [
  'debtStatus',
  'totalDebt',
  'overdueAmount',
  'requiredPaymentAmount',
  'daysOverdue',
] as const;

const statusLabel = (status: string) => DEBT_STATUS_LABELS[status] ?? status;

export const customerDebtsTool: AiTool = {
  name: 'customer_debts',
  label: 'Đang xem công nợ',
  description:
    'Theo dõi công nợ khách hàng (khách có chính sách công nợ và đang còn nợ): tổng nợ, quá hạn, đến hạn, cần thu, vượt hạn mức, số khách theo trạng thái nợ; danh sách khách nợ (mã KH…, tên, chi nhánh, Sale PIC, nợ hiện tại, quá hạn, số ngày quá hạn, hạn gần nhất, hạn mức, lần thanh toán gần nhất, phiếu thu hồi đang mở). Khi tìm đúng một khách: kèm hoá đơn còn nợ và các lần thanh toán gần đây. Người không được xem dữ liệu nhân viên khác chỉ thấy khách mình là Sale PIC.',
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Tên, mã (KH…) hoặc SĐT khách hàng.',
      },
      debtStatus: {
        type: 'string',
        enum: DEBT_STATUSES,
        description: 'OVERDUE = Quá hạn, DUE = Đến hạn, NORMAL = Bình thường.',
      },
      overLimitOnly: {
        type: 'boolean',
        description: 'true = chỉ khách đã vượt hạn mức công nợ.',
      },
      orderBy: {
        type: 'string',
        enum: ORDER_BY,
        description:
          'Sắp xếp giảm dần theo: debtStatus (nghiêm trọng nhất trước, mặc định), totalDebt, overdueAmount, requiredPaymentAmount, daysOverdue.',
      },
      currentBranchOnly: currentBranchParameter,
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('debt_tracking:view'),
  async run({ scope, deps }, args) {
    const limit = limitOf(args);
    const branchId = branchOf(scope, args);
    const debtStatus =
      typeof args.debtStatus === 'string' &&
      DEBT_STATUSES.includes(args.debtStatus)
        ? args.debtStatus
        : undefined;
    const orderBy = ORDER_BY.find((key) => key === args.orderBy);
    const ownOnly = !scope.user.canViewOtherStaffData;
    const query = {
      search: str(args, 'search'),
      debtStatus,
      ...(bool(args, 'overLimitOnly') ? { overLimitOnly: true } : {}),
      ...(branchId ? { branchId } : {}),
      // Service không tự giới hạn theo người xem → chỉ khách mình là Sale PIC.
      ...(ownOnly ? { salePicIds: [scope.user.id] } : {}),
      orderBy,
      orderDirection: 'desc',
      page: 1,
      pageSize: limit,
    } as DebtTrackingQueryDto;

    const [summary, list] = await Promise.all([
      deps.debtTracking.getSummary(query),
      deps.debtTracking.findAll(query),
    ]);

    const customers = list.data.map((row) => ({
      code: row.code,
      name: row.name,
      branch: row.branch?.name ?? null,
      salePic: row.policy.salePic?.name ?? null,
      debtForm: row.policy.debtForm
        ? (DEBT_FORM_LABELS[row.policy.debtForm] ?? row.policy.debtForm)
        : null,
      debtStatus: statusLabel(row.debtStatus),
      totalDebt: money(row.totalDebt),
      overdueAmount: money(row.overdueAmount),
      dueAmount: money(row.dueAmount),
      requiredPaymentAmount: money(row.requiredPaymentAmount),
      maxDaysOverdue: row.maxDaysOverdue,
      nearestDueDate: day(row.nearestDueDate),
      creditLimit: row.creditLimit != null ? money(row.creditLimit) : null,
      overLimitAmount: money(row.overLimitAmount),
      lastPayment: row.lastPayment
        ? {
            date: day(row.lastPayment.transDate),
            amount: money(row.lastPayment.amount),
          }
        : null,
      openTicket: row.openTicket?.ticketCode ?? null,
    }));

    const result: Record<string, unknown> = {
      dataScope: ownOnly
        ? 'Chỉ khách người hỏi là Sale PIC'
        : 'Mọi khách theo dõi công nợ',
      branch: branchId ? 'Chi nhánh đang chọn' : 'Mọi chi nhánh',
      summary: {
        customerCount: summary.totalCustomers,
        totalDebt: money(summary.totalDebt),
        overdueAmount: money(summary.overdueAmount),
        dueAmount: money(summary.dueAmount),
        dueSoonAmount: money(summary.dueSoonAmount),
        notDueAmount: money(summary.notDueAmount),
        requiredPaymentAmount: money(summary.requiredPaymentAmount),
        overLimitAmount: money(summary.overLimitAmount),
        customersOverLimit: summary.customersOverLimit,
        customersWithOpenTicket: summary.customersWithOpenTicket,
        customersByDebtStatus: Object.fromEntries(
          Object.entries(summary.byDebtStatus).map(([key, value]) => [
            statusLabel(key),
            value,
          ]),
        ),
      },
      customers,
      ...listMeta(customers.length, list.pagination.total),
    };

    // Tìm ra đúng một khách (đã qua giới hạn Sale PIC ở trên) → kèm chi tiết.
    if (query.search && list.pagination.total === 1 && list.data[0]) {
      const detail = await deps.debtTracking.getDetail(list.data[0].customerId);
      result.detail = {
        code: detail.customer.code,
        outstandingInvoices: detail.aging.outstandingInvoices
          .slice(0, 20)
          .map((invoice) => ({
            code: invoice.code,
            purchaseDate: day(invoice.purchaseDate),
            grandTotal: money(invoice.grandTotal),
            outstanding: money(invoice.outstanding),
            dueDate: day(invoice.dueDate),
            isOverdue: invoice.isOverdue,
            daysOverdue: invoice.daysOverdue,
          })),
        outstandingInvoiceCount: detail.aging.outstandingInvoices.length,
        recentPayments: detail.recentPayments.slice(0, 10).map((payment) => ({
          code: payment.code,
          date: day(payment.transDate),
          amount: money(payment.amount),
        })),
      };
    }

    return result;
  },
};
