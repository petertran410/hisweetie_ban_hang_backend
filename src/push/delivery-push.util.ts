import type { PushMessage } from './push.service';

export interface DeliveredSlip {
  code: string;
  invoices: {
    invoice: {
      id: number;
      code: string;
      soldById: number | null;
      customer: { name: string | null } | null;
    } | null;
  }[];
}

/**
 * Thông báo "đã giao hàng thành công" cho người bán của từng hóa đơn trong
 * báo đơn: mỗi hóa đơn một thông báo (bấm vào mở đúng hóa đơn đó).
 * Bỏ qua hóa đơn không có người bán, và người bán chính là người vừa báo đơn.
 * `onlyInvoiceIds`: khi sửa báo đơn, chỉ báo cho hóa đơn mới thêm vào.
 */
export function buildDeliveryPushes(
  slip: DeliveredSlip,
  actorId: number | undefined,
  onlyInvoiceIds?: readonly number[],
): PushMessage[] {
  const only = onlyInvoiceIds ? new Set(onlyInvoiceIds) : null;
  const messages: PushMessage[] = [];
  const seen = new Set<number>();
  for (const row of slip.invoices) {
    const inv = row.invoice;
    if (!inv || inv.soldById == null || seen.has(inv.id)) continue;
    if (only && !only.has(inv.id)) continue;
    if (inv.soldById === actorId) continue;
    seen.add(inv.id);
    const customer = inv.customer?.name?.trim();
    messages.push({
      userId: inv.soldById,
      title: 'Đã giao hàng thành công',
      body: `${customer ? `${inv.code} · ${customer}` : inv.code} — báo đơn ${slip.code}`,
      data: { type: 'invoice-delivered', invoiceId: inv.id },
    });
  }
  return messages;
}
