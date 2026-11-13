import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Production } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceAccessService } from '../auth/finance-access.service';
import { ApplyProductionCostDto } from './dto/production-factory.dto';
import { ensureInventoryRow } from '../common/production-factory.util';
import { ensureExternalCostSnapshot } from '../manufacturers/external-production.util';
import {
  outputSpec,
  readOutputSpec,
  specKey,
  specLabel,
} from './production-cost.util';

/**
 * Phiếu gửi NSX áp giá vốn được từ lúc gửi (Đã gửi / Nhận một phần /
 * Hoàn thành) vì giá thành chốt lúc gửi; phiếu cũ chỉ khi Hoàn thành.
 */
const canApplyStatus = (row: {
  manufacturerId: number | null;
  status: number;
}) => (row.manufacturerId ? [2, 4, 5].includes(row.status) : row.status === 2);

@Injectable()
export class ProductionCostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
  ) {}

  async authorize(
    productId: number,
    branchId: number,
    scope: string | undefined,
    userId: number,
  ) {
    const inventories = await this.prisma.inventory.findMany({
      where: { productId, ...(scope === 'allBranches' ? {} : { branchId }) },
      select: { branchId: true },
    });
    const targets = new Set(inventories.map((row) => row.branchId));
    targets.add(branchId);
    for (const target of [...targets].sort((a, b) => a - b)) {
      await this.access.assert(userId, target, 'productions:apply_cost');
    }
  }

  private batchPrice(row: Production) {
    const spec = readOutputSpec(row.outputSpecSnapshot);
    if (!spec || !row.costSnapshotAt || row.batchUnitCost == null) {
      throw new BadRequestException(
        'Phiếu thiếu snapshot giá thành hoặc đơn vị/quy cách, không thể áp giá theo đợt',
      );
    }
    return { price: row.batchUnitCost, spec };
  }

  async preview(
    id: number,
    scope: 'receiveBranch' | 'allBranches' = 'receiveBranch',
    userId: number,
  ) {
    const row = await this.prisma.production.findUnique({ where: { id } });
    if (!row?.isExternal)
      throw new NotFoundException('Không tìm thấy phiếu gửi sản xuất');
    if (!canApplyStatus(row) || row.costAppliedAt)
      throw new ConflictException('Phiếu chưa gửi, đã hủy hoặc đã áp giá vốn');
    if (row.manufacturerId) {
      // Giá thành chốt lúc gửi: áp được trước khi nhận hàng.
      await ensureInventoryRow(
        this.prisma,
        row.productId,
        row.destinationBranchId,
      );
      Object.assign(
        row,
        await ensureExternalCostSnapshot(
          this.prisma as unknown as Prisma.TransactionClient,
          row,
        ),
      );
    }
    const { price, spec } = this.batchPrice(row);
    const actor = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { supplierId: true },
    });
    if (row.manufacturerId && actor.supplierId)
      throw new ForbiddenException(
        'Luồng gửi sản xuất chỉ dành cho nhân viên nội bộ',
      );
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: row.productId },
    });
    if (row.manufacturerId && ![2, 4].includes(product.type))
      throw new BadRequestException(
        'Thành phẩm không còn là hàng hóa quản lý tồn',
      );
    if (specKey(spec) !== specKey(outputSpec(product)))
      throw new ConflictException('Đơn vị/quy cách sản phẩm đã thay đổi');
    await this.authorize(row.productId, row.destinationBranchId, scope, userId);
    const inventories = await this.prisma.inventory.findMany({
      where: {
        productId: row.productId,
        ...(scope === 'allBranches'
          ? {}
          : { branchId: row.destinationBranchId }),
      },
      include: { branch: { select: { name: true } } },
      orderBy: { branchId: 'asc' },
    });
    if (!inventories.some((item) => item.branchId === row.destinationBranchId))
      throw new BadRequestException('Không tìm thấy kho nhận thành phẩm');
    return {
      productionId: row.id,
      code: row.code,
      productName: row.productName,
      scope,
      unitCost: Number(price),
      variantLabel: specLabel(spec),
      targets: inventories.map((item) => ({
        branchId: item.branchId,
        branchName: item.branch.name,
        cost: Number(item.cost),
        delta: Number(price.sub(item.cost)),
      })),
    };
  }

  /** All cost writers, including the legacy receipt, pass this boundary. */
  async write(
    tx: Prisma.TransactionClient,
    row: Production,
    dto: ApplyProductionCostDto,
    userId: number,
    legacyReceipt = false,
  ) {
    if (
      !row.isExternal ||
      !(legacyReceipt ? row.status === 4 : canApplyStatus(row)) ||
      row.costAppliedAt
    ) {
      throw new ConflictException('Phiếu chưa gửi, đã hủy hoặc đã áp giá vốn');
    }
    const scope = dto.scope ?? 'receiveBranch';
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, supplierId: true },
    });
    if (row.manufacturerId && user.supplierId)
      throw new ForbiddenException(
        'Luồng gửi sản xuất chỉ dành cho nhân viên nội bộ',
      );
    // Stabilize the target set and specification while acquiring inventory locks.
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${row.productId} FOR UPDATE`;
    const product = await tx.product.findUniqueOrThrow({
      where: { id: row.productId },
    });
    if (row.manufacturerId && ![2, 4].includes(product.type))
      throw new BadRequestException(
        'Thành phẩm không còn là hàng hóa quản lý tồn',
      );
    const batch = !!row.manufacturerId || dto.basis === 'batch';
    const cost = batch
      ? this.batchPrice(row).price
      : new Prisma.Decimal(dto.newCost ?? -1);
    if (!cost.isFinite() || cost.lt(0))
      throw new BadRequestException('Giá vốn mới không hợp lệ');
    if (
      batch &&
      specKey(this.batchPrice(row).spec) !== specKey(outputSpec(product))
    ) {
      throw new ConflictException(
        'Đơn vị/quy cách sản phẩm đã thay đổi, không thể áp giá',
      );
    }
    const inventories = await tx.inventory.findMany({
      where: {
        productId: row.productId,
        ...(scope === 'allBranches'
          ? {}
          : { branchId: row.destinationBranchId }),
      },
      orderBy: { branchId: 'asc' },
    });
    if (
      !inventories.length ||
      !inventories.some((item) => item.branchId === row.destinationBranchId)
    )
      throw new BadRequestException(
        'Không tìm thấy tồn kho thành phẩm tại kho nhận',
      );
    for (const inv of inventories)
      await this.access.assert(userId, inv.branchId, 'productions:apply_cost');
    const expected = new Map(
      dto.expectedCosts?.map((item) => [
        item.branchId,
        new Prisma.Decimal(item.cost),
      ]) ?? [],
    );
    if (dto.expectedOldCost != null && !expected.has(row.destinationBranchId))
      expected.set(
        row.destinationBranchId,
        new Prisma.Decimal(dto.expectedOldCost),
      );
    if (
      dto.expectedCosts &&
      (new Set(dto.expectedCosts.map((item) => item.branchId)).size !==
        dto.expectedCosts.length ||
        dto.expectedCosts.some(
          (item) => !inventories.some((inv) => inv.branchId === item.branchId),
        ))
    ) {
      throw new ConflictException(
        'Danh sách kho xác nhận không khớp, vui lòng xem lại',
      );
    }
    if (batch && inventories.some((item) => !expected.has(item.branchId)))
      throw new ConflictException(
        'Cần xem trước giá vốn của tất cả kho được cập nhật',
      );
    const changes: Array<{ branchId: number; before: string; after: string }> =
      [];
    for (const inv of inventories) {
      await tx.$queryRaw`SELECT id FROM inventories WHERE id = ${inv.id} FOR UPDATE`;
      const current = await tx.inventory.findUniqueOrThrow({
        where: { id: inv.id },
      });
      if (
        expected.has(inv.branchId) &&
        !current.cost.equals(expected.get(inv.branchId)!)
      )
        throw new ConflictException(
          'Giá vốn đã thay đổi, vui lòng xem lại trước khi áp',
        );
      changes.push({
        branchId: inv.branchId,
        before: current.cost.toString(),
        after: cost.toString(),
      });
    }
    // No writes occur until every target has passed authorization and stale checks.
    for (const inv of inventories)
      await tx.inventory.update({ where: { id: inv.id }, data: { cost } });
    return {
      costAppliedAt: new Date(),
      appliedUnitCost: cost,
      costAppliedById: userId,
      costAppliedByName: user.name ?? user.email,
      costAppliedScope: scope,
      costApplicationSnapshot: { basis: batch ? 'batch' : 'legacy', changes },
    };
  }

  async apply(id: number, dto: ApplyProductionCostDto, userId: number) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM productions WHERE id = ${id} FOR UPDATE`;
        const row = await tx.production.findUnique({ where: { id } });
        if (!row)
          throw new NotFoundException('Không tìm thấy phiếu gửi sản xuất');
        if (row.manufacturerId && canApplyStatus(row) && !row.costAppliedAt) {
          await ensureInventoryRow(tx, row.productId, row.destinationBranchId);
          Object.assign(row, await ensureExternalCostSnapshot(tx, row));
        }
        const data = await this.write(tx, row, dto, userId);
        return tx.production.update({ where: { id }, data });
      },
      { timeout: 60000 },
    );
  }
}
