import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONSIGNMENT_RETURN_STATUS,
  ConsignmentReturnQueryDto,
  CreateConsignmentReturnDto,
  getReturnStatusLabel,
} from './dto';
import { CONSIGNMENT_STATUS } from '../consignments/dto/consignment-status.constants';
import { ConsignmentsService } from '../consignments/consignments.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import {
  buildInventoryLogActor,
  buildInventoryLogBase,
} from '../common/inventory-log.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';

@Injectable()
export class ConsignmentReturnsService {
  constructor(
    private prisma: PrismaService,
    private consignmentsService: ConsignmentsService,
    private larkProductSync: LarkProductSyncService,
    private auditLogsService: AuditLogsService,
  ) {}

  private async generateCode(tx: any): Promise<string> {
    const last = await tx.consignmentReturn.findFirst({
      orderBy: { id: 'desc' },
    });
    const nextId = last ? last.id + 1 : 1;
    return `HKG${nextId.toString().padStart(6, '0')}`;
  }

  /**
   * Số lượng còn có thể hoàn theo từng product của 1 phiếu ký gửi:
   *   remaining = consigned − invoiced − đã hoàn (các phiếu hoàn chưa hủy).
   */
  private async getReturnableMap(
    tx: any,
    consignmentId: number,
  ): Promise<Record<number, number>> {
    const consignment = await tx.consignment.findUnique({
      where: { id: consignmentId },
      include: {
        items: true,
        invoices: { where: { status: { not: 2 } }, include: { details: true } },
      },
    });
    if (!consignment) {
      throw new NotFoundException('Không tìm thấy phiếu ký gửi');
    }

    const invoicedQty: Record<number, number> = {};
    for (const inv of consignment.invoices) {
      for (const d of inv.details) {
        if (d.productId == null) continue;
        invoicedQty[d.productId] =
          (invoicedQty[d.productId] || 0) + Number(d.quantity);
      }
    }

    // Tách 2 khái niệm: đã nhận về kho (STOCK_RECEIVED) và đang chờ nhận
    // (REQUEST). Cả hai đều trừ khi tính "còn có thể hoàn" để chống tạo phiếu
    // trùng vượt số còn lại; nhưng status COMPLETED chỉ tính phần đã nhận.
    const existingReturns = await tx.consignmentReturn.findMany({
      where: {
        consignmentId,
        status: { not: CONSIGNMENT_RETURN_STATUS.CANCELLED },
      },
      include: { details: true },
    });
    const returnedQty: Record<number, number> = {};
    for (const ro of existingReturns) {
      for (const d of ro.details) {
        returnedQty[d.productId] =
          (returnedQty[d.productId] || 0) + Number(d.returnQuantity);
      }
    }

    const map: Record<number, number> = {};
    for (const it of consignment.items) {
      const remaining =
        Number(it.quantity) -
        (invoicedQty[it.productId] || 0) -
        (returnedQty[it.productId] || 0);
      map[it.productId] = remaining;
    }
    return map;
  }

  /**
   * Số lượng đã hoàn & NHẬN VỀ KHO (STOCK_RECEIVED) theo từng product.
   * Dùng cho điều kiện COMPLETED — chỉ tính hàng thực sự đã về kho.
   */
  private async getReceivedMap(
    tx: any,
    consignmentId: number,
  ): Promise<Record<number, number>> {
    const receivedReturns = await tx.consignmentReturn.findMany({
      where: {
        consignmentId,
        status: CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED,
      },
      include: { details: true },
    });
    const receivedQty: Record<number, number> = {};
    for (const ro of receivedReturns) {
      for (const d of ro.details) {
        receivedQty[d.productId] =
          (receivedQty[d.productId] || 0) + Number(d.returnQuantity);
      }
    }
    return receivedQty;
  }

  async create(dto: CreateConsignmentReturnDto, userId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const consignment = await tx.consignment.findUnique({
        where: { id: dto.consignmentId },
        include: {
          items: true,
          customer: { select: { id: true, name: true } },
        },
      });
      if (!consignment) {
        throw new NotFoundException('Không tìm thấy phiếu ký gửi');
      }
      // Chỉ hoàn được khi hàng đã giao (đang ký gửi tại khách).
      if (
        ![
          CONSIGNMENT_STATUS.DELIVERED,
          CONSIGNMENT_STATUS.PARTIALLY_INVOICED,
        ].includes(consignment.status as any)
      ) {
        throw new BadRequestException(
          'Chỉ hoàn hàng với phiếu đã giao (đang ký gửi tại khách).',
        );
      }

      const returnable = await this.getReturnableMap(tx, dto.consignmentId);
      const itemByProduct = new Map(
        consignment.items.map((it: any) => [it.productId, it]),
      );

      const validDetails = (dto.details || []).filter(
        (d) => Number(d.returnQuantity) > 0,
      );
      if (validDetails.length === 0) {
        throw new BadRequestException('Chưa nhập số lượng hoàn.');
      }

      const detailsData: any[] = [];
      let totalReturnQuantity = 0;
      for (const d of validDetails) {
        const item: any = itemByProduct.get(d.productId);
        if (!item) {
          throw new BadRequestException(
            `Sản phẩm ${d.productId} không thuộc phiếu ký gửi.`,
          );
        }
        const good = Number(d.goodQuantity) || 0;
        const damaged = Number(d.damagedQuantity) || 0;
        const nearExpiry = Number(d.nearExpiryQuantity) || 0;
        const bucketSum = good + damaged + nearExpiry;
        const returnQuantity =
          bucketSum > 0 ? bucketSum : Number(d.returnQuantity);

        const max = returnable[d.productId] ?? 0;
        if (returnQuantity > max) {
          throw new BadRequestException(
            `Sản phẩm ${item.productName}: Số lượng hoàn (${returnQuantity}) vượt quá còn lại (${max}).`,
          );
        }

        totalReturnQuantity += returnQuantity;
        detailsData.push({
          productId: d.productId,
          productCode: item.productCode,
          productName: item.productName,
          consignedQuantity: item.quantity,
          returnQuantity,
          goodQuantity: good,
          damagedQuantity: damaged,
          nearExpiryQuantity: nearExpiry,
          manufactureDate: d.manufactureDate
            ? new Date(d.manufactureDate)
            : (item.manufactureDate ?? null),
          note: d.note || null,
        });
      }

      const code = await this.generateCode(tx);

      const created = await tx.consignmentReturn.create({
        data: {
          code,
          consignmentId: consignment.id,
          consignmentCode: consignment.code,
          customerId: consignment.customerId,
          branchId: consignment.branchId as number,
          status: CONSIGNMENT_RETURN_STATUS.REQUEST,
          statusValue: getReturnStatusLabel(CONSIGNMENT_RETURN_STATUS.REQUEST),
          totalReturnQuantity,
          note: dto.note || null,
          createdBy: userId,
          details: { createMany: { data: detailsData } },
        },
        include: { details: true },
      });

      return created;
    });

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai tạo phiếu hoàn ký gửi).
    if (result) {
      const [actorUser, customer] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        }),
        result.customerId
          ? this.prisma.customer.findUnique({
              where: { id: result.customerId },
              select: { name: true },
            })
          : null,
      ]);
      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'CONSIGNMENT_RETURN_CREATE',
        entityType: 'consignment_returns',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode('CONSIGNMENT_RETURN_CREATE'),
        severity: getSeverityFromActionCode('CONSIGNMENT_RETURN_CREATE'),
        snapshot: {
          code: result.code,
          consignmentCode: result.consignmentCode,
          status: result.status,
          statusValue: result.statusValue,
          totalReturnQuantity: result.totalReturnQuantity,
          items: result.details?.map((d: any) => ({
            productCode: d.productCode,
            productName: d.productName,
            returnQuantity: d.returnQuantity,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_RETURN_CREATE', {
          consignmentReturnCode: result.code,
          customerName: customer?.name || '',
        }),
        messageTemplate: 'CONSIGNMENT_RETURN_CREATE',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  /**
   * Bước 2: xác nhận đã nhận hàng → hoàn kho + ghi inventoryLog
   * 'CONSIGNMENT_RETURN'. Không đụng công nợ.
   */
  async confirmStockReceived(id: number, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const ro = await tx.consignmentReturn.findUnique({
        where: { id },
        include: { details: true },
      });
      if (!ro) throw new NotFoundException('Không tìm thấy phiếu hoàn ký gửi');
      if (ro.status === CONSIGNMENT_RETURN_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu hoàn đã hủy.');
      }
      if (ro.status === CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED) {
        throw new BadRequestException('Phiếu hoàn đã nhận hàng.');
      }

      const branch = await tx.branch.findUnique({
        where: { id: ro.branchId },
        select: { id: true, name: true },
      });
      const customer = ro.customerId
        ? await tx.customer.findUnique({
            where: { id: ro.customerId },
            select: { id: true, name: true },
          })
        : null;

      // Fetch người thực hiện để ghi userId/createdByName vào InventoryLog
      // (truy vết ai nhận hàng hoàn ký gửi vào kho).
      const crReceiveUser = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const crReceiveLogActor = buildInventoryLogActor(
        userId,
        crReceiveUser?.name || crReceiveUser?.email,
      );

      for (const d of ro.details) {
        const good = Number(d.goodQuantity) || 0;
        const damaged = Number(d.damagedQuantity) || 0;
        const nearExpiry = Number(d.nearExpiryQuantity) || 0;
        const total = Number(d.returnQuantity);
        const invSnapshot = await tx.inventory.findFirst({
          where: { productId: d.productId, branchId: ro.branchId },
        });

        await tx.inventory.upsert({
          where: {
            productId_branchId: {
              productId: d.productId,
              branchId: ro.branchId,
            },
          },
          update: {
            onHand: { increment: total },
            ...(damaged > 0 && { damagedQuantity: { increment: damaged } }),
            ...(nearExpiry > 0 && {
              nearExpiryQuantity: { increment: nearExpiry },
            }),
          },
          create: {
            productId: d.productId,
            productCode: d.productCode,
            productName: d.productName,
            branchId: ro.branchId,
            branchName: branch?.name || '',
            onHand: total,
            damagedQuantity: damaged,
            nearExpiryQuantity: nearExpiry,
          },
        });
        touchedProductIds.add(d.productId);

        await tx.inventoryLog.create({
          data: {
            productId: d.productId,
            productCode: d.productCode,
            productName: d.productName,
            branchId: ro.branchId,
            branchName: branch?.name || '',
            transactionType: 'CONSIGNMENT_RETURN',
            refCode: ro.code,
            refType: 'consignment_return',
            refId: ro.id,
            quantity: total, // dương = hàng nhập lại kho
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
            transactionPrice: 0,
            partnerId: ro.customerId || null,
            partnerName: customer?.name || null,
            manufactureDate: d.manufactureDate ?? null,
            ...buildInventoryLogBase(crReceiveLogActor),
          },
        });
      }

      const updated = await tx.consignmentReturn.update({
        where: { id },
        data: {
          status: CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED,
          statusValue: getReturnStatusLabel(
            CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED,
          ),
          receivedById: userId,
        },
        include: { details: true },
      });

      // Hàng đã về kho → recompute trạng thái phiếu ký gửi (remaining=0 → COMPLETED).
      await this.consignmentsService.updateConsignmentStatusByInvoices(
        ro.consignmentId,
        tx,
      );

      return updated;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai nhận hàng hoàn ký gửi vào kho).
    if (result) {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CONSIGNMENT_RETURN_STOCK_RECEIVED',
        entityType: 'consignment_returns',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode(
          'CONSIGNMENT_RETURN_STOCK_RECEIVED',
        ),
        severity: getSeverityFromActionCode(
          'CONSIGNMENT_RETURN_STOCK_RECEIVED',
        ),
        snapshot: {
          code: result.code,
          consignmentCode: result.consignmentCode,
          status: result.status,
          statusValue: result.statusValue,
          totalReturnQuantity: result.totalReturnQuantity,
          items: result.details?.map((d: any) => ({
            productCode: d.productCode,
            productName: d.productName,
            returnQuantity: d.returnQuantity,
            goodQuantity: d.goodQuantity,
            damagedQuantity: d.damagedQuantity,
            nearExpiryQuantity: d.nearExpiryQuantity,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_RETURN_STOCK_RECEIVED', {
          consignmentReturnCode: result.code,
        }),
        messageTemplate: 'CONSIGNMENT_RETURN_STOCK_RECEIVED',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  async cancel(id: number, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const ro = await tx.consignmentReturn.findUnique({
        where: { id },
        include: { details: true },
      });
      if (!ro) throw new NotFoundException('Không tìm thấy phiếu hoàn ký gửi');
      if (ro.status === CONSIGNMENT_RETURN_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu hoàn đã hủy.');
      }

      // Nếu đã hoàn kho → đảo kho bằng dòng CONSIGNMENT_RETURN_CANCEL.
      if (ro.status === CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED) {
        const branch = await tx.branch.findUnique({
          where: { id: ro.branchId },
          select: { id: true, name: true },
        });
        // Fetch người thực hiện để ghi userId/createdByName vào InventoryLog
        // đảo chiều khi hủy (truy vết ai rollback kho hoàn ký gửi).
        const crCancelUser = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        const crCancelLogActor = buildInventoryLogActor(
          userId,
          crCancelUser?.name || crCancelUser?.email,
        );
        for (const d of ro.details) {
          const damaged = Number(d.damagedQuantity) || 0;
          const nearExpiry = Number(d.nearExpiryQuantity) || 0;
          const total = Number(d.returnQuantity);
          await tx.inventory.updateMany({
            where: { productId: d.productId, branchId: ro.branchId },
            data: {
              onHand: { decrement: total },
              ...(damaged > 0 && { damagedQuantity: { decrement: damaged } }),
              ...(nearExpiry > 0 && {
                nearExpiryQuantity: { decrement: nearExpiry },
              }),
            },
          });
          touchedProductIds.add(d.productId);
          await tx.inventoryLog.create({
            data: {
              productId: d.productId,
              productCode: d.productCode,
              productName: d.productName,
              branchId: ro.branchId,
              branchName: branch?.name || '',
              transactionType: 'CONSIGNMENT_RETURN_CANCEL',
              refCode: ro.code,
              refType: 'consignment_return',
              refId: ro.id,
              quantity: -total,
              costPrice: 0,
              transactionPrice: 0,
              partnerId: ro.customerId || null,
              partnerName: null,
              ...buildInventoryLogBase(crCancelLogActor),
            },
          });
        }
      }

      const updated = await tx.consignmentReturn.update({
        where: { id },
        data: {
          status: CONSIGNMENT_RETURN_STATUS.CANCELLED,
          statusValue: getReturnStatusLabel(
            CONSIGNMENT_RETURN_STATUS.CANCELLED,
          ),
        },
        include: { details: true },
      });

      // Hủy phiếu đã nhận kho → hàng rời kho lại → phiếu KG có thể rời
      // COMPLETED về PARTIALLY_INVOICED. Recompute để đồng bộ.
      await this.consignmentsService.updateConsignmentStatusByInvoices(
        ro.consignmentId,
        tx,
      );

      return updated;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai hủy phiếu hoàn ký gửi).
    if (result) {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CONSIGNMENT_RETURN_CANCEL',
        entityType: 'consignment_returns',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode('CONSIGNMENT_RETURN_CANCEL'),
        severity: getSeverityFromActionCode('CONSIGNMENT_RETURN_CANCEL'),
        snapshot: {
          code: result.code,
          consignmentCode: result.consignmentCode,
          status: result.status,
          statusValue: result.statusValue,
          items: result.details?.map((d: any) => ({
            productCode: d.productCode,
            productName: d.productName,
            returnQuantity: d.returnQuantity,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_RETURN_CANCEL', {
          consignmentReturnCode: result.code,
        }),
        messageTemplate: 'CONSIGNMENT_RETURN_CANCEL',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  async findAll(query: ConsignmentReturnQueryDto) {
    const where: any = {};
    if (query.consignmentId) where.consignmentId = query.consignmentId;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { consignmentCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const data = await this.prisma.consignmentReturn.findMany({
      where,
      include: { details: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data, total: data.length };
  }

  async findOne(id: number) {
    const ro = await this.prisma.consignmentReturn.findUnique({
      where: { id },
      include: {
        details: true,
        customer: { select: { id: true, name: true } },
      },
    });
    if (!ro) throw new NotFoundException('Không tìm thấy phiếu hoàn ký gửi');
    return ro;
  }

  /** Số lượng còn có thể hoàn theo product (cho modal). */
  async getReturnable(consignmentId: number) {
    return this.prisma.$transaction((tx) =>
      this.getReturnableMap(tx, consignmentId),
    );
  }
}
