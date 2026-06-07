// ====================================================================
// NGUỒN CHÂN LÝ DUY NHẤT cho việc TÍNH LẠI trạng thái giao hàng của hóa đơn
// dựa trên các phiếu báo đơn (đóng hàng / loading / giao hàng) đang gắn.
//
// Bậc trạng thái (cao → thấp):
//   - Có phiếu GIAO HÀNG (PackingSlip)        → DELIVERED(7)
//   - else có phiếu LOADING (PackingLoading)  → LOADING(6)
//   - else có phiếu ĐÓNG HÀNG (PackingHang)   → PACKED(5)
//   - else (không còn phiếu nào)              → PROCESSING(3)
//
// CHỈ tính các phiếu CHƯA HỦY (cancelledAt = null). Phiếu đã hủy vẫn lưu
// trong DB (soft-cancel) nhưng không còn ảnh hưởng trạng thái hóa đơn.
//
// Dùng khi HỦY một phiếu để hoàn (lùi) trạng thái hóa đơn về bậc cao nhất
// còn lại. Mỗi hóa đơn được tính độc lập.
//
// Lưu ý: helper chỉ đổi invoice.status / statusValue trong DB nội bộ,
// KHÔNG đụng đến sync KiotViet/Lark.
// ====================================================================

import { INVOICE_STATUS, getStatusLabel } from '../invoices/dto';
import { BadRequestException } from '@nestjs/common';

export type PackingType = 'giao-hang' | 'loading' | 'dong-hang';

const TYPE_LABEL: Record<PackingType, string> = {
  'giao-hang': 'giao hàng',
  loading: 'loading',
  'dong-hang': 'đóng hàng',
};

/**
 * Đếm số phiếu CHƯA HỦY của từng loại đang gắn hóa đơn.
 * Có thể loại trừ 1 phiếu (phiếu đang hủy) khỏi việc đếm.
 */
async function countActivePackings(
  tx: any,
  invoiceId: number,
  exclude?: { type: PackingType; id: number },
): Promise<{ slips: number; loadings: number; hangs: number }> {
  const slipWhere: any = {
    invoiceId,
    packingSlip: { cancelledAt: null },
  };
  const loadingWhere: any = {
    invoiceId,
    packingLoading: { cancelledAt: null },
  };
  const hangWhere: any = {
    invoiceId,
    packingHang: { cancelledAt: null },
  };

  if (exclude?.type === 'giao-hang') {
    slipWhere.packingSlipId = { not: exclude.id };
  } else if (exclude?.type === 'loading') {
    loadingWhere.packingLoadingId = { not: exclude.id };
  } else if (exclude?.type === 'dong-hang') {
    hangWhere.packingHangId = { not: exclude.id };
  }

  const [slips, loadings, hangs] = await Promise.all([
    tx.packingSlipInvoice.count({ where: slipWhere }),
    tx.packingLoadingInvoice.count({ where: loadingWhere }),
    tx.packingHangInvoice.count({ where: hangWhere }),
  ]);

  return { slips, loadings, hangs };
}

/**
 * Tính bậc trạng thái cao nhất của 1 hóa đơn dựa trên số phiếu còn gắn.
 */
function resolveStatus(counts: {
  slips: number;
  loadings: number;
  hangs: number;
}): number {
  if (counts.slips > 0) return INVOICE_STATUS.DELIVERED;
  if (counts.loadings > 0) return INVOICE_STATUS.LOADING;
  if (counts.hangs > 0) return INVOICE_STATUS.PACKED;
  return INVOICE_STATUS.PROCESSING;
}

/**
 * Kiểm tra trước khi HỦY phiếu:
 *  1. Chặn nếu phiếu chứa hóa đơn đã HỦY (CANCELLED).
 *  2. Chặn nếu hủy phiếu KHÔNG ở bậc cao nhất (phải hủy phiếu bậc cao hơn trước).
 *     Chỉ xét các phiếu CHƯA HỦY (loại trừ chính phiếu đang hủy).
 *
 * @param tx          Prisma transaction client
 * @param invoiceIds  Danh sách hóa đơn thuộc phiếu đang muốn hủy
 * @param cancellingType Loại phiếu đang hủy
 * @param cancellingId   Id phiếu đang hủy (loại khỏi việc đếm)
 * @throws BadRequestException nếu vi phạm
 */
export async function assertCanCancelPacking(
  tx: any,
  invoiceIds: number[],
  cancellingType: PackingType,
  cancellingId: number,
): Promise<void> {
  if (invoiceIds.length === 0) return;

  // 1. Chặn nếu có hóa đơn đã hủy
  const cancelled = await tx.invoice.findFirst({
    where: { id: { in: invoiceIds }, status: INVOICE_STATUS.CANCELLED },
    select: { code: true },
  });
  if (cancelled) {
    throw new BadRequestException(
      `Không thể hủy phiếu vì hóa đơn ${cancelled.code} đã bị hủy`,
    );
  }

  // 2. Chặn hủy sai thứ tự (LIFO theo bậc) — chỉ xét phiếu chưa hủy khác
  for (const invoiceId of invoiceIds) {
    const { slips, loadings } = await countActivePackings(tx, invoiceId, {
      type: cancellingType,
      id: cancellingId,
    });

    // Hủy ĐÓNG HÀNG: chặn nếu còn loading hoặc giao
    if (cancellingType === 'dong-hang') {
      if (slips > 0) {
        throw new BadRequestException(
          'Phải hủy phiếu giao hàng trước khi hủy phiếu đóng hàng',
        );
      }
      if (loadings > 0) {
        throw new BadRequestException(
          'Phải hủy phiếu loading trước khi hủy phiếu đóng hàng',
        );
      }
    }

    // Hủy LOADING: chặn nếu còn giao
    if (cancellingType === 'loading') {
      if (slips > 0) {
        throw new BadRequestException(
          'Phải hủy phiếu giao hàng trước khi hủy phiếu loading',
        );
      }
    }

    // Hủy GIAO HÀNG: luôn cho phép (bậc cao nhất)
  }
}

/**
 * Tính lại & cập nhật trạng thái hóa đơn SAU KHI phiếu đã được đánh dấu hủy.
 * Mỗi hóa đơn tính độc lập dựa trên phiếu CHƯA HỦY còn lại.
 *
 * @param tx          Prisma transaction client (phiếu đã set cancelledAt)
 * @param invoiceIds  Danh sách hóa đơn cần tính lại
 */
export async function recalcInvoiceStatusAfterPackingCancel(
  tx: any,
  invoiceIds: number[],
): Promise<void> {
  for (const invoiceId of invoiceIds) {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { status: true },
    });
    // Hóa đơn đã hủy thì không can thiệp (đã chặn ở trên, phòng ngừa)
    if (!invoice || invoice.status === INVOICE_STATUS.CANCELLED) continue;

    const counts = await countActivePackings(tx, invoiceId);
    const newStatus = resolveStatus(counts);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: newStatus,
        statusValue: getStatusLabel(newStatus),
      },
    });
  }
}

export { TYPE_LABEL };
