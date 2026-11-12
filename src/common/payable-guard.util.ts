import { BadRequestException } from '@nestjs/common';

export async function assertNoManagedPayable(tx: any, targetType: string, targetId: number) {
  const count = await tx.payableAllocation.count({ where: { targetType, targetId, status: 1 } });
  if (count) throw new BadRequestException('Chứng từ có phân bổ thanh toán chung. Hãy hủy lần phân bổ ở công nợ trước khi sửa hoặc hủy chứng từ');
}

export async function lockPurchaseOrderAccount(tx: any, id: number) {
  const row = await tx.purchaseOrder.findUnique({ where: { id }, select: { supplierId: true } });
  if (row) await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${row.supplierId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
}
