// ====================================================================
// Tích hợp phiếu báo đơn (đóng hàng / loading / giao hàng) cho PHIẾU KÝ GỬI.
//
// Phiếu ký gửi tái dùng hệ packing như hóa đơn để chuyển trạng thái kho:
//   - phiếu ĐÓNG HÀNG (PackingHang)   → PACKED(3)
//   - phiếu LOADING   (PackingLoading)→ LOADING(4)
//   - phiếu GIAO HÀNG (PackingSlip)   → DELIVERED(5)
//
// KHÁC hóa đơn: phiếu ký gửi CHƯA trừ kho lúc tạo (B1). Kho được trừ MỘT LẦN
// duy nhất tại lần đầu phiếu rời CONFIRMED qua bất kỳ phiếu packing nào
// (dung hòa luồng "lỏng"): nếu đang CONFIRMED → trừ kho + ghi log 'CONSIGNMENT_OUT'.
// Đã ở PACKED/LOADING/DELIVERED → chỉ đổi trạng thái, không trừ lại.
// Chặn nếu phiếu đang ở PENDING (chưa xác nhận) hoặc CANCELLED/COMPLETED.
//
// Khi HỦY phiếu packing: tính lại bậc trạng thái từ các phiếu CHƯA HỦY còn
// lại; nếu rớt về dưới PACKED (tức CONFIRMED) → HOÀN KHO bằng cách XÓA các
// dòng inventoryLog 'CONSIGNMENT_OUT' của phiếu + cộng lại onHand (không sinh
// dòng CONSIGNMENT_OUT_CANCEL).
// ====================================================================

import { BadRequestException } from '@nestjs/common';
import {
  CONSIGNMENT_STATUS,
  getStatusLabel,
} from '../consignments/dto/consignment-status.constants';
import type { PackingType } from './packing-status.util';

const PACKING_TYPE_TO_STATUS: Record<PackingType, number> = {
  'dong-hang': CONSIGNMENT_STATUS.PACKED,
  loading: CONSIGNMENT_STATUS.LOADING,
  'giao-hang': CONSIGNMENT_STATUS.DELIVERED,
};

/**
 * Trừ kho cho 1 phiếu ký gửi (nếu chưa trừ) và ghi inventoryLog 'CONSIGNMENT_OUT'.
 * Idempotent ở mức nghiệp vụ: chỉ trừ khi consignment đang CONFIRMED.
 */
async function deductConsignmentStock(tx: any, consignment: any) {
  const branch = consignment.branchId
    ? await tx.branch.findUnique({
        where: { id: consignment.branchId },
        select: { id: true, name: true },
      })
    : null;

  for (const item of consignment.items) {
    const invSnapshot = await tx.inventory.findFirst({
      where: { productId: item.productId, branchId: consignment.branchId },
    });

    await tx.inventory.updateMany({
      where: { productId: item.productId, branchId: consignment.branchId },
      data: { onHand: { decrement: Number(item.quantity) } },
    });

    await tx.inventoryLog.create({
      data: {
        productId: item.productId,
        productCode: item.productCode || '',
        productName: item.productName || '',
        branchId: consignment.branchId,
        branchName: branch?.name || '',
        transactionType: 'CONSIGNMENT_OUT',
        refCode: consignment.code,
        refType: 'consignment',
        refId: consignment.id,
        quantity: -Number(item.quantity),
        costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
        transactionPrice: Number(item.price),
        partnerId: consignment.customerId || null,
        partnerName: consignment.customer?.name || null,
        manufactureDate: item.manufactureDate ?? null,
      },
    });
  }
}

/**
 * Hoàn kho cho 1 phiếu ký gửi: cộng lại onHand theo các dòng log
 * 'CONSIGNMENT_OUT' rồi XÓA chúng (không sinh dòng CANCEL).
 */
export async function restoreConsignmentStock(tx: any, consignmentId: number) {
  const logs = await tx.inventoryLog.findMany({
    where: {
      refType: 'consignment',
      refId: consignmentId,
      transactionType: 'CONSIGNMENT_OUT',
    },
  });

  for (const log of logs) {
    await tx.inventory.updateMany({
      where: { productId: log.productId, branchId: log.branchId },
      data: { onHand: { increment: Math.abs(Number(log.quantity)) } },
    });
  }

  if (logs.length > 0) {
    await tx.inventoryLog.deleteMany({
      where: {
        refType: 'consignment',
        refId: consignmentId,
        transactionType: 'CONSIGNMENT_OUT',
      },
    });
  }
}

/**
 * Gắn 1 phiếu packing (đang tạo) vào danh sách phiếu ký gửi:
 *  - validate cùng chi nhánh
 *  - chặn PENDING / CANCELLED / COMPLETED
 *  - trừ kho lần đầu rời CONFIRMED
 *  - đổi Consignment.status theo loại phiếu
 *
 * Trả về branchId (để gán cho phiếu packing nếu cần).
 */
export async function applyPackingToConsignments(
  tx: any,
  consignmentIds: number[],
  packingType: PackingType,
): Promise<void> {
  if (!consignmentIds || consignmentIds.length === 0) return;

  const consignments = await tx.consignment.findMany({
    where: { id: { in: consignmentIds } },
    include: {
      items: true,
      customer: { select: { id: true, name: true } },
    },
  });

  if (consignments.length !== consignmentIds.length) {
    throw new BadRequestException('Không tìm thấy phiếu ký gửi');
  }

  const targetStatus = PACKING_TYPE_TO_STATUS[packingType];

  for (const c of consignments) {
    if (c.status === CONSIGNMENT_STATUS.PENDING) {
      throw new BadRequestException(
        `Phiếu ký gửi ${c.code} đang ở trạng thái Phiếu tạm — cần xác nhận trước khi xử lý kho`,
      );
    }
    if (
      c.status === CONSIGNMENT_STATUS.CANCELLED ||
      c.status === CONSIGNMENT_STATUS.COMPLETED
    ) {
      throw new BadRequestException(
        `Phiếu ký gửi ${c.code} đã ${getStatusLabel(c.status).toLowerCase()} — không thể xử lý kho`,
      );
    }

    // Lần đầu rời CONFIRMED → trừ kho 1 lần.
    if (c.status === CONSIGNMENT_STATUS.CONFIRMED) {
      await deductConsignmentStock(tx, c);
    }

    await tx.consignment.update({
      where: { id: c.id },
      data: {
        status: targetStatus,
        statusValue: getStatusLabel(targetStatus),
        consignStatus:
          targetStatus === CONSIGNMENT_STATUS.PACKED
            ? 'packed'
            : targetStatus === CONSIGNMENT_STATUS.LOADING
              ? 'loading'
              : 'delivered',
      },
    });
  }
}

/**
 * Đếm số phiếu packing CHƯA HỦY của từng loại đang gắn 1 phiếu ký gửi.
 */
async function countActiveConsignmentPackings(
  tx: any,
  consignmentId: number,
): Promise<{ slips: number; loadings: number; hangs: number }> {
  const [slips, loadings, hangs] = await Promise.all([
    tx.packingSlipInvoice.count({
      where: { consignmentId, packingSlip: { cancelledAt: null } },
    }),
    tx.packingLoadingInvoice.count({
      where: { consignmentId, packingLoading: { cancelledAt: null } },
    }),
    tx.packingHangInvoice.count({
      where: { consignmentId, packingHang: { cancelledAt: null } },
    }),
  ]);
  return { slips, loadings, hangs };
}

/**
 * Tính lại trạng thái phiếu ký gửi SAU KHI 1 phiếu packing bị hủy.
 * Bậc: giao-hang→DELIVERED, loading→LOADING, dong-hang→PACKED, không còn→CONFIRMED.
 * Nếu rớt về CONFIRMED (không còn phiếu packing nào) → HOÀN KHO.
 */
export async function recalcConsignmentStatusAfterPackingCancel(
  tx: any,
  consignmentIds: number[],
): Promise<void> {
  for (const consignmentId of consignmentIds) {
    const c = await tx.consignment.findUnique({
      where: { id: consignmentId },
      select: { status: true },
    });
    if (
      !c ||
      c.status === CONSIGNMENT_STATUS.CANCELLED ||
      c.status === CONSIGNMENT_STATUS.COMPLETED ||
      c.status === CONSIGNMENT_STATUS.PARTIALLY_INVOICED
    ) {
      // Đã xuất hóa đơn / hủy / hoàn thành: không lùi trạng thái kho.
      continue;
    }

    const counts = await countActiveConsignmentPackings(tx, consignmentId);
    let newStatus: number;
    if (counts.slips > 0) newStatus = CONSIGNMENT_STATUS.DELIVERED;
    else if (counts.loadings > 0) newStatus = CONSIGNMENT_STATUS.LOADING;
    else if (counts.hangs > 0) newStatus = CONSIGNMENT_STATUS.PACKED;
    else newStatus = CONSIGNMENT_STATUS.CONFIRMED;

    // Rớt về CONFIRMED (không còn phiếu packing nào) → hoàn kho.
    if (newStatus === CONSIGNMENT_STATUS.CONFIRMED) {
      await restoreConsignmentStock(tx, consignmentId);
    }

    const consignStatusKey =
      newStatus === CONSIGNMENT_STATUS.DELIVERED
        ? 'delivered'
        : newStatus === CONSIGNMENT_STATUS.LOADING
          ? 'loading'
          : newStatus === CONSIGNMENT_STATUS.PACKED
            ? 'packed'
            : 'confirmed';

    await tx.consignment.update({
      where: { id: consignmentId },
      data: {
        status: newStatus,
        statusValue: getStatusLabel(newStatus),
        consignStatus: consignStatusKey,
      },
    });
  }
}
