import type { OrderQueryDto } from '../../orders/dto';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_STRING_MAP,
} from '../../orders/dto/order-status.constants';
import { dateRange, rangeParameters, str, type AiTool } from './common';
import {
  branchOf,
  currentBranchParameter,
  day,
  limitOf,
  limitParameter,
  listMeta,
  money,
  pickList,
  vnEndIso,
  vnStartIso,
} from './tool-helpers';

const STATUS_KEYS = Object.keys(ORDER_STATUS_STRING_MAP) as Array<
  keyof typeof ORDER_STATUS_STRING_MAP
>;
const DEFAULT_STATUSES = STATUS_KEYS.filter((key) => key !== 'cancelled');

const STATUS_LABEL_BY_KEY: Record<string, string> = Object.fromEntries(
  STATUS_KEYS.map((key) => [
    key,
    ORDER_STATUS_LABELS[ORDER_STATUS_STRING_MAP[key]] ?? key,
  ]),
);

const statusLabel = (status: number) =>
  ORDER_STATUS_LABELS[status as keyof typeof ORDER_STATUS_LABELS] ??
  String(status);

export const ordersSummaryTool: AiTool = {
  name: 'orders_summary',
  label: 'Đang xem đơn đặt hàng',
  description:
    'Tổng hợp đơn đặt hàng (theo ngày đặt) trong khoảng ngày: số đơn, tổng tiền, đã trả/cọc, còn nợ; số đơn theo trạng thái (Phiếu tạm, Đã xác nhận, Đã ra 1 phần hóa đơn, Hoàn thành, Đã hủy); danh sách đơn gần nhất (mã DH…, ngày, khách, chi nhánh, người bán, tiền, trạng thái, hoá đơn đã ra). Lọc được theo trạng thái và khách/mã đơn. Người không được xem dữ liệu nhân viên khác chỉ thấy đơn do mình tạo.',
  parameters: {
    type: 'object',
    properties: {
      ...rangeParameters,
      statuses: {
        type: 'array',
        items: { type: 'string', enum: STATUS_KEYS },
        description:
          'Trạng thái: pending = Phiếu tạm, confirmed = Đã xác nhận, partially_invoiced = Đã ra 1 phần hóa đơn, completed = Hoàn thành, cancelled = Đã hủy. Bỏ trống = mọi trạng thái trừ Đã hủy. Đơn chờ xử lý = pending + confirmed.',
      },
      search: {
        type: 'string',
        description: 'Mã đơn (DH…) hoặc tên / mã / SĐT khách hàng.',
      },
      currentBranchOnly: currentBranchParameter,
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('orders:view'),
  async run({ scope, now, deps }, args) {
    const range = dateRange(args, now);
    if ('error' in range) return range;
    const statuses = pickList(args, 'statuses', STATUS_KEYS);
    const limit = limitOf(args);
    const branchId = branchOf(scope, args);
    const query = {
      fromDate: vnStartIso(range.from),
      toDate: vnEndIso(range.to),
      statuses: statuses ?? DEFAULT_STATUSES,
      search: str(args, 'search'),
      ...(branchId ? { branchId } : {}),
      pageSize: limit,
      currentItem: 0,
      orderBy: 'orderDate',
      orderDirection: 'desc',
      includeStatusCounts: true,
    } as OrderQueryDto;

    const [totals, list] = await Promise.all([
      deps.orders.getTotals(query, scope.user),
      deps.orders.findAll(query, scope.user),
    ]);

    const counts: Record<string, number> = list.statusCounts ?? {};
    const countsByStatus = Object.fromEntries(
      STATUS_KEYS.filter((key) => counts[key]).map((key) => [
        STATUS_LABEL_BY_KEY[key],
        counts[key],
      ]),
    );

    const orders = list.data.map((order) => ({
      code: order.code,
      date: day(order.orderDate),
      customer: order.customer
        ? { code: order.customer.code, name: order.customer.name }
        : null,
      branch: order.branch?.name ?? null,
      soldBy: order.soldBy?.name ?? null,
      saleChannel: order.saleChannel?.name ?? null,
      grandTotal: money(order.grandTotal),
      paidAmount: money(order.paidAmount),
      debtAmount: money(order.debtAmount),
      status: statusLabel(order.status),
      invoiceCodes: order.invoices.map((invoice) => invoice.code),
    }));

    return {
      from: range.from,
      to: range.to,
      dataScope: scope.user.canViewOtherStaffData
        ? 'Mọi đơn đặt hàng'
        : 'Chỉ đơn do người hỏi tạo',
      branch: branchId ? 'Chi nhánh đang chọn' : 'Mọi chi nhánh',
      totals: {
        orderCount: totals.count,
        goodsAmount: money(totals.totalAmount),
        shippingFee: money(totals.shippingFee),
        grandTotal: money(totals.grandTotal),
        paidAmount: money(totals.paidAmount),
        debtAmount: money(totals.debtAmount),
      },
      countsByStatus,
      orders,
      ...listMeta(orders.length, list.total),
    };
  },
};
