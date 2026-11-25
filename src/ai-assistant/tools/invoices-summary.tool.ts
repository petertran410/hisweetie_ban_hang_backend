import type { InvoiceQueryDto } from '../../invoices/dto';
import {
  INVOICE_STATUS,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_STRING_MAP,
} from '../../invoices/dto/invoice-status.constants';
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

const STATUS_KEYS = Object.keys(INVOICE_STATUS_STRING_MAP) as Array<
  keyof typeof INVOICE_STATUS_STRING_MAP
>;

/** Mặc định như màn Hóa đơn: mọi trạng thái trừ Đã hủy và Trả hàng. */
const DEFAULT_STATUS_IDS: number[] = Object.values(INVOICE_STATUS).filter(
  (status) =>
    status !== INVOICE_STATUS.CANCELLED && status !== INVOICE_STATUS.RETURNED,
);

/** Trường dùng tới của một dòng InvoicesService.findAll (service trả any). */
interface InvoiceRow {
  code: string;
  purchaseDate: Date;
  customer: { code: string | null; name: string } | null;
  branch: { name: string } | null;
  soldBy: { name: string } | null;
  order: { code: string } | null;
  grandTotal: unknown;
  paidAmount: unknown;
  remainingAmount: unknown;
  status: number;
}

const statusLabel = (status: number) =>
  INVOICE_STATUS_LABELS[status as keyof typeof INVOICE_STATUS_LABELS] ??
  String(status);

export const invoicesSummaryTool: AiTool = {
  name: 'invoices_summary',
  label: 'Đang tra cứu hoá đơn',
  description:
    'Tổng hợp hoá đơn bán hàng (theo ngày mua) trong khoảng ngày: số hoá đơn, tiền hàng, khách cần trả, đã trả, còn phải thu, trả hàng; số hoá đơn theo từng trạng thái; danh sách hoá đơn gần nhất (mã HD…, ngày, khách, chi nhánh, người bán, tiền, trạng thái). Lọc được theo trạng thái, khách hàng, mã hoá đơn. Người không được xem dữ liệu nhân viên khác chỉ thấy hoá đơn do mình tạo.',
  parameters: {
    type: 'object',
    properties: {
      ...rangeParameters,
      statuses: {
        type: 'array',
        items: { type: 'string', enum: STATUS_KEYS },
        description:
          'Trạng thái: processing = Đang xử lý, completed = Hoàn thành, packed = Đóng hàng, loading = Lấy hàng, delivered = Giao thành công, failed_delivery = Không giao được, returned = Trả hàng, cancelled = Đã hủy. Bỏ trống = mọi trạng thái trừ Đã hủy và Trả hàng.',
      },
      customer: {
        type: 'string',
        description: 'Tên, mã (KH…) hoặc SĐT khách hàng cần lọc.',
      },
      invoiceCode: {
        type: 'string',
        description: 'Một phần mã hoá đơn (HD…).',
      },
      currentBranchOnly: currentBranchParameter,
      limit: limitParameter,
    },
    additionalProperties: false,
  },
  available: (scope) => scope.can('invoices:view'),
  async run({ scope, now, deps }, args) {
    const range = dateRange(args, now);
    if ('error' in range) return range;
    const statuses = pickList(args, 'statuses', STATUS_KEYS);
    const limit = limitOf(args);
    const branchId = branchOf(scope, args);
    const query = {
      fromPurchaseDate: vnStartIso(range.from),
      toPurchaseDate: vnEndIso(range.to),
      statusIds: statuses
        ? statuses.map((key) => INVOICE_STATUS_STRING_MAP[key])
        : DEFAULT_STATUS_IDS,
      customerSearch: str(args, 'customer'),
      invoiceCodeSearch: str(args, 'invoiceCode'),
      ...(branchId ? { branchId } : {}),
      pageSize: limit,
      currentItem: 0,
      orderBy: 'purchaseDate',
      orderDirection: 'desc',
      includeStatusCounts: true,
    } as InvoiceQueryDto;

    const [totals, list] = await Promise.all([
      deps.invoices.getTotals(query, scope.user),
      deps.invoices.findAll(query, scope.user),
    ]);

    const counts: Record<string, number> = list.statusCounts ?? {};
    const countsByStatus = Object.fromEntries(
      Object.entries(counts)
        .filter(([key]) => key !== 'all')
        .map(([key, value]) => [statusLabel(Number(key)), value]),
    );

    const invoices = (list.data as InvoiceRow[]).map((invoice) => ({
      code: invoice.code,
      date: day(invoice.purchaseDate),
      customer: invoice.customer
        ? { code: invoice.customer.code, name: invoice.customer.name }
        : null,
      branch: invoice.branch?.name ?? null,
      soldBy: invoice.soldBy?.name ?? null,
      orderCode: invoice.order?.code ?? null,
      grandTotal: money(invoice.grandTotal),
      paidAmount: money(invoice.paidAmount),
      remainingAmount: money(invoice.remainingAmount),
      status: statusLabel(invoice.status),
    }));

    return {
      from: range.from,
      to: range.to,
      dataScope: scope.user.canViewOtherStaffData
        ? 'Mọi hoá đơn'
        : 'Chỉ hoá đơn do người hỏi tạo',
      branch: branchId ? 'Chi nhánh đang chọn' : 'Mọi chi nhánh',
      totals: {
        invoiceCount: totals.count,
        goodsAmount: money(totals.totalAmount),
        shippingFee: money(totals.shippingFee),
        customerPayable: money(totals.grandTotal),
        paidAmount: money(totals.paidAmount),
        debtAmount: money(totals.debtAmount),
        returnOrderAmount: money(totals.returnOrderAmount),
        remainingAmount: money(totals.remainingAmount),
      },
      countsByStatus,
      invoices,
      ...listMeta(invoices.length, list.total),
    };
  },
};
