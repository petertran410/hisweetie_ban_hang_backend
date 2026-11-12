import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionCostHistoryQueryDto } from './dto/production-cost-history.dto';
import { readOutputSpec, specKey, specLabel } from './production-cost.util';

@Injectable()
export class ProductionCostHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async history(query: ProductionCostHistoryQueryDto, chart = false) {
    const to = query.toDate ? new Date(query.toDate) : new Date();
    // A date-only upper bound includes the whole selected day.
    if (query.toDate?.length === 10) to.setUTCHours(23, 59, 59, 999);
    const from = query.fromDate ? new Date(query.fromDate) : new Date(to);
    if (!query.fromDate) from.setUTCFullYear(from.getUTCFullYear() - 1);
    if (from > to)
      throw new BadRequestException('Ngày bắt đầu phải trước ngày kết thúc');
    const rows = await this.prisma.production.findMany({
      where: {
        isExternal: true,
        manufacturerId: query.manufacturerId ?? { not: null },
        productId: query.productId,
        status: 2,
        completedDate: { gte: from, lte: to },
      },
      orderBy: [{ completedDate: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        productId: true,
        productCode: true,
        productName: true,
        manufacturerId: true,
        manufacturer: { select: { name: true } },
        externalTemplateName: true,
        formulaName: true,
        completedDate: true,
        receivedQuantity: true,
        quantity: true,
        materialValue: true,
        manufacturerMaterialCost: true,
        processingFee: true,
        totalCost: true,
        feeCurrency: true,
        feeExchangeRate: true,
        feeForeignAmount: true,
        batchUnitCost: true,
        outputSpecSnapshot: true,
        costSnapshotAt: true,
        costAppliedAt: true,
        appliedUnitCost: true,
        costAppliedByName: true,
        costAppliedScope: true,
        destinationBranchId: true,
        destinationBranchName: true,
      },
    });
    const variants = new Map<string, string>();
    const previous = new Map<string, { id: number; cost: Prisma.Decimal }>();
    const data = rows.flatMap((row) => {
      const spec = readOutputSpec(row.outputSpecSnapshot);
      const key = spec ? specKey(spec) : 'missing';
      variants.set(key, specLabel(spec));
      if (query.variantKey && key !== query.variantKey) return [];
      const quantity = row.receivedQuantity ?? row.quantity;
      const cost =
        row.batchUnitCost ??
        (quantity.gt(0)
          ? row.totalCost.div(quantity).toDecimalPlaces(6)
          : null);
      const complete = !!(
        spec &&
        row.costSnapshotAt &&
        row.batchUnitCost != null
      );
      // Unknown historical specifications must never be compared with one another.
      const prior = complete ? previous.get(key) : undefined;
      const delta = cost != null && prior ? cost.sub(prior.cost) : null;
      if (complete && cost != null) previous.set(key, { id: row.id, cost });
      return [
        {
          ...row,
          manufacturerName: row.manufacturer?.name ?? '',
          manufacturer: undefined,
          variantKey: key,
          variantLabel: specLabel(spec),
          outputSpec: spec,
          snapshotMissing: !complete,
          canApply: complete && !row.costAppliedAt,
          receivedQuantity: Number(quantity),
          unitCost: cost == null ? null : Number(cost),
          materialValue: Number(row.materialValue),
          manufacturerMaterialCost: Number(row.manufacturerMaterialCost),
          processingFee: Number(row.processingFee),
          totalCost: Number(row.totalCost),
          previousProductionId: prior?.id ?? null,
          deltaAmount: delta == null ? null : Number(delta),
          deltaPercent:
            delta != null && prior && !prior.cost.isZero()
              ? Number(delta.div(prior.cost).mul(100).toDecimalPlaces(4))
              : null,
        },
      ];
    });
    const page = query.page ?? 1,
      pageSize = query.pageSize ?? 20;
    return {
      data: chart ? data : data.slice((page - 1) * pageSize, page * pageSize),
      total: data.length,
      page,
      pageSize,
      variants: [...variants].map(([key, label]) => ({ key, label })),
    };
  }
}
