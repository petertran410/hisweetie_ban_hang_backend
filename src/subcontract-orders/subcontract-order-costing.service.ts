import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import {
  computeSubcontractTotals,
  computeWeightedAverageCost,
  SUBCONTRACT_STATUS,
} from '../common/subcontract-order.util';
import { ApplyCostDto } from './dto';

/**
 * Giá vốn thành phẩm gia công.
 *
 * Hệ thống KHÔNG tự cập nhật giá vốn ở bất kỳ chứng từ nào, nên ở đây cũng
 * không ghi ngầm: `preview` chỉ tính và đề xuất, `apply` là nơi DUY NHẤT của
 * module ghi `Inventory.cost`, và chỉ khi người dùng xác nhận.
 */
@Injectable()
export class SubcontractOrderCostingService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  private async loadCompletedOrder(db: any, id: number) {
    const order = await db.subcontractOrder.findUnique({
      where: { id },
      include: { materials: true, receipts: true, costs: true, payments: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy lệnh gia công');
    if (order.status !== SUBCONTRACT_STATUS.COMPLETED) {
      throw new BadRequestException(
        'Chỉ tính giá vốn khi lệnh đã hoàn thành và quyết toán',
      );
    }
    return order;
  }

  private async buildPreview(db: any, order: any) {
    const totals = computeSubcontractTotals(order);
    const inventories = await db.inventory.findMany({
      where: { productId: order.productId },
      select: { branchId: true, branchName: true, onHand: true, cost: true },
      orderBy: { branchId: 'asc' },
    });

    const receive = inventories.find(
      (i: any) => i.branchId === order.receiveBranchId,
    );
    const oldCost = receive ? Number(receive.cost) : 0;
    const onHand = receive ? Number(receive.onHand) : 0;
    const { otherQuantity, proposedCost } = computeWeightedAverageCost({
      onHand,
      oldCost,
      goodQuantity: totals.goodQuantity,
      unitCost: totals.unitCost,
    });

    return {
      orderId: order.id,
      productId: order.productId,
      productName: order.productName,
      receiveBranchId: order.receiveBranchId,
      receiveBranchName: order.receiveBranchName,
      goodQuantity: totals.goodQuantity,
      totalCost: totals.totalCost,
      unitCost: totals.unitCost,
      onHand,
      oldCost,
      otherQuantity,
      proposedCost,
      applied: !!order.costAppliedAt,
      appliedUnitCost:
        order.appliedUnitCost != null ? Number(order.appliedUnitCost) : null,
      branches: inventories.map((i: any) => ({
        branchId: i.branchId,
        branchName: i.branchName,
        onHand: Number(i.onHand),
        cost: Number(i.cost),
        isReceiveBranch: i.branchId === order.receiveBranchId,
      })),
    };
  }

  async preview(id: number) {
    const order = await this.loadCompletedOrder(this.prisma, id);
    return this.buildPreview(this.prisma, order);
  }

  async apply(id: number, dto: ApplyCostDto, userId: number) {
    const scope = dto.scope || 'receiveBranch';
    if (dto.newCost <= 0) {
      throw new BadRequestException('Giá vốn mới phải lớn hơn 0');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.loadCompletedOrder(tx, id);
      if (order.costAppliedAt) {
        throw new BadRequestException('Lệnh này đã áp giá vốn rồi');
      }

      const preview = await this.buildPreview(tx, order);
      // Người dùng xác nhận dựa trên giá cũ đã thấy; nếu giá đã bị đổi ở nơi
      // khác trong lúc đó thì bắt xem lại thay vì ghi đè mù.
      if (
        dto.expectedOldCost != null &&
        Math.abs(preview.oldCost - dto.expectedOldCost) > 0.005
      ) {
        throw new ConflictException(
          'Giá vốn hiện tại đã thay đổi, vui lòng xem lại trước khi áp',
        );
      }

      const targets = preview.branches.filter(
        (b: any) => scope === 'allBranches' || b.isReceiveBranch,
      );
      if (!targets.some((b: any) => b.isReceiveBranch)) {
        throw new BadRequestException(
          'Thành phẩm chưa có tồn kho tại kho nhận',
        );
      }

      await tx.inventory.updateMany({
        where: {
          productId: order.productId,
          branchId: { in: targets.map((b: any) => b.branchId) },
        },
        data: { cost: dto.newCost },
      });

      const updated = await tx.subcontractOrder.update({
        where: { id },
        data: {
          costAppliedAt: new Date(),
          costAppliedById: userId,
          appliedUnitCost: dto.newCost,
          appliedCostSnapshot: {
            scope,
            unitCost: preview.unitCost,
            proposedCost: preview.proposedCost,
            goodQuantity: preview.goodQuantity,
            branches: targets.map((b: any) => ({
              branchId: b.branchId,
              branchName: b.branchName,
              onHand: b.onHand,
              oldCost: b.cost,
              newCost: dto.newCost,
            })),
          },
        },
      });
      return { order: updated, preview };
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const actionCode = 'SUBCONTRACT_ORDER_APPLY_COST';
    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode,
      entityType: 'subcontract_order',
      entityId: id.toString(),
      entityCode: result.order.code,
      category: getCategoryFromActionCode(actionCode),
      severity: getSeverityFromActionCode(actionCode),
      snapshot: result.order.appliedCostSnapshot,
      message: renderAuditMessage(actionCode, {
        orderCode: result.order.code,
        productName: result.order.productName,
        newCostAmount: dto.newCost,
      }),
      messageTemplate: actionCode,
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: result.order.receiveBranchId,
    });

    return this.preview(id);
  }
}
