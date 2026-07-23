import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingLoadingDto,
  UpdatePackingLoadingDto,
  PackingLoadingQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { INVOICE_STATUS, getStatusLabel } from 'src/invoices/dto';
import {
  assertCanCancelPacking,
  recalcInvoiceStatusAfterPackingCancel,
} from '../common/packing-status.util';
import { LarkLoadingNotificationService } from '../lark-sync/services/lark-loading-notification.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import {
  applyPackingToConsignments,
  recalcConsignmentStatusAfterPackingCancel,
} from '../common/consignment-packing.util';
import {
  buildInventoryLogActor,
  InventoryLogActor,
} from '../common/inventory-log.util';

@Injectable()
export class PackingLoadingsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private larkLoadingNotification: LarkLoadingNotificationService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  async findAll(query: PackingLoadingQueryDto) {
    const {
      branchId,
      invoiceId,
      search,
      limit,
      pageSize,
      currentItem = 0,
    } = query;
    const take = limit || pageSize || 15;

    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (invoiceId) {
      where.invoices = {
        some: {
          invoiceId: invoiceId,
        },
      };
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.packingLoading.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          loadingBy: { select: { id: true, name: true } },
          invoices: {
            include: {
              invoice: {
                select: {
                  id: true,
                  code: true,
                  customerId: true,
                  purchaseDate: true,
                  grandTotal: true,
                  customer: {
                    select: {
                      id: true,
                      name: true,
                      contactNumber: true,
                    },
                  },
                },
              },
              consignment: {
                select: {
                  id: true,
                  code: true,
                  customerId: true,
                  consignDate: true,
                  grandTotal: true,
                  customer: {
                    select: { id: true, name: true, contactNumber: true },
                  },
                },
              },
            },
          },
          images: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: take,
      }),
      this.prisma.packingLoading.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const packingLoading = await this.prisma.packingLoading.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        loadingBy: { select: { id: true, name: true } },
        invoices: {
          include: {
            invoice: {
              select: {
                id: true,
                code: true,
                customerId: true,
                purchaseDate: true,
                grandTotal: true,
                customer: {
                  select: {
                    id: true,
                    name: true,
                    contactNumber: true,
                  },
                },
              },
            },
            consignment: {
              select: {
                id: true,
                code: true,
                customerId: true,
                consignDate: true,
                grandTotal: true,
                customer: {
                  select: { id: true, name: true, contactNumber: true },
                },
              },
            },
          },
        },
        images: true,
      },
    });

    if (!packingLoading) {
      throw new NotFoundException(`Packing loading with ID ${id} not found`);
    }

    return packingLoading;
  }

  async create(dto: CreatePackingLoadingDto, userId: number) {
    const isConsignment = !!dto.consignmentIds && dto.consignmentIds.length > 0;
    const touchedProductIds = new Set<number>();

    const packingLoading = await this.prisma.$transaction(async (tx) => {
      if (isConsignment) {
        const code = await this.generateCode(tx);
        const created = await tx.packingLoading.create({
          data: {
            code,
            branchId: dto.branchId,
            loadingById: dto.loadingById,
            numberOfPackages: dto.numberOfPackages,
            note: dto.note,
            createdBy: userId,
            invoices: {
              create: dto.consignmentIds!.map((consignmentId) => ({
                consignmentId,
              })),
            },
            images: dto.imageUrls
              ? { create: dto.imageUrls.map((url) => ({ imageUrl: url })) }
              : undefined,
          },
          include: {
            branch: true,
            creator: true,
            loadingBy: true,
            invoices: { include: { invoice: true, consignment: true } },
            images: true,
          },
        });

        // Fetch người thực hiện trong tx để ghi userId/createdByName vào
        // InventoryLog CONSIGNMENT_OUT (truy vết ai xuất kho ký gửi).
        const consignActorUser = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        const consignActor: InventoryLogActor = buildInventoryLogActor(
          userId,
          consignActorUser?.name || consignActorUser?.email,
        );
        const touched = await applyPackingToConsignments(
          tx,
          dto.consignmentIds!,
          'loading',
          consignActor,
        );
        for (const productId of touched) touchedProductIds.add(productId);

        // Ghi audit log cho action xuất kho ký gửi (truy vết ai trừ kho ký gửi).
        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'CONSIGNMENT_STOCK_OUT',
          entityType: 'consignments',
          entityCode: created.code,
          category: getCategoryFromActionCode('CONSIGNMENT_STOCK_OUT'),
          severity: getSeverityFromActionCode('CONSIGNMENT_STOCK_OUT'),
          snapshot: {
            packingCode: created.code,
            packingType: 'loading',
            consignmentIds: dto.consignmentIds,
            productCount: touched.size,
          },
          message: renderAuditMessage('CONSIGNMENT_STOCK_OUT', {
            consignmentCode: created.code,
            productCount: touched.size,
          }),
          messageTemplate: 'CONSIGNMENT_STOCK_OUT',
          userId,
          userName: consignActorUser?.name || consignActorUser?.email || 'System',
          branchId: created.branchId || undefined,
        });
        return created;
      }

      const invoices = await tx.invoice.findMany({
        where: { id: { in: dto.invoiceIds } },
        select: {
          id: true,
          code: true,
          status: true,
          branchId: true,
          orderId: true,
        },
      });

      if (invoices.length === 0) {
        throw new BadRequestException('Không tìm thấy hóa đơn');
      }

      // Chặn loading cho hóa đơn đã giao hàng thành công (DELIVERED)
      // hoặc đã hoàn thành (COMPLETED).
      const delivered = invoices.find(
        (inv) =>
          inv.status === INVOICE_STATUS.DELIVERED ||
          inv.status === INVOICE_STATUS.COMPLETED,
      );
      if (delivered) {
        throw new BadRequestException(
          `Hóa đơn ${delivered.code} đã giao hàng, không thể loading`,
        );
      }

      const firstBranchId = invoices[0].branchId;
      const hasDifferentBranch = invoices.some(
        (inv) => inv.branchId !== firstBranchId,
      );

      if (hasDifferentBranch) {
        throw new BadRequestException('Các hóa đơn phải cùng chi nhánh');
      }

      const code = await this.generateCode(tx);

      const created = await tx.packingLoading.create({
        data: {
          code,
          branchId: dto.branchId,
          loadingById: dto.loadingById,
          numberOfPackages: dto.numberOfPackages,
          note: dto.note,
          createdBy: userId,
          invoices: {
            create: dto.invoiceIds!.map((invoiceId) => ({ invoiceId })),
          },
          images: dto.imageUrls
            ? { create: dto.imageUrls.map((url) => ({ imageUrl: url })) }
            : undefined,
        },
        include: {
          branch: true,
          creator: true,
          loadingBy: true,
          invoices: { include: { invoice: true } },
          images: true,
        },
      });

      await tx.invoice.updateMany({
        where: {
          id: { in: dto.invoiceIds },
          status: {
            notIn: [
              INVOICE_STATUS.CANCELLED,
              INVOICE_STATUS.COMPLETED,
              INVOICE_STATUS.DELIVERED,
            ],
          },
        },
        data: {
          status: INVOICE_STATUS.LOADING,
          statusValue: getStatusLabel(INVOICE_STATUS.LOADING),
        },
      });

      return created;
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    // Audit log ngoài transaction
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'PACKING_LOADING_CREATE',
      entityType: 'packing_loadings',
      entityId: packingLoading.id.toString(),
      entityCode: packingLoading.code,
      category: getCategoryFromActionCode('PACKING_LOADING_CREATE'),
      severity: getSeverityFromActionCode('PACKING_LOADING_CREATE'),
      snapshot: this.buildPackingLoadingSnapshot(packingLoading),
      message: renderAuditMessage('PACKING_LOADING_CREATE', {
        packingCode: packingLoading.code,
      }),
      messageTemplate: 'PACKING_LOADING_CREATE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: packingLoading.branchId || undefined,
    });

    // Gửi card thông báo loading vào Lark group theo chi nhánh
    // (fire-and-forget — lỗi gửi không làm fail việc tạo phiếu)
    if (!isConsignment) {
      this.larkLoadingNotification.notifyLoadingCreatedAsync(packingLoading.id);
    }

    return packingLoading;
  }

  /**
   * Gửi lại thủ công card loading lên Lark group.
   * CHỜ kết quả để báo lỗi rõ ràng cho người dùng.
   */
  async resendLarkNotification(id: number) {
    await this.findOne(id); // đảm bảo tồn tại → 404 nếu không có
    await this.larkLoadingNotification.resendLoadingNotification(id);
    return { message: 'Đã gửi lại thông báo loading lên Lark' };
  }

  async update(id: number, dto: UpdatePackingLoadingDto, userId?: number) {
    const packingLoading = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.invoiceIds) {
        const invoices = await tx.invoice.findMany({
          where: { id: { in: dto.invoiceIds } },
          select: { id: true, branchId: true },
        });

        const firstBranchId = invoices[0].branchId;
        const hasDifferentBranch = invoices.some(
          (inv) => inv.branchId !== firstBranchId,
        );

        if (hasDifferentBranch) {
          throw new BadRequestException('Các hóa đơn phải cùng chi nhánh');
        }
      }

      const updateData: any = {
        branchId: dto.branchId,
        loadingById: dto.loadingById,
        numberOfPackages: dto.numberOfPackages,
        note: dto.note,
      };

      if (dto.invoiceIds) {
        await tx.packingLoadingInvoice.deleteMany({
          where: { packingLoadingId: id },
        });
        updateData.invoices = {
          create: dto.invoiceIds.map((invoiceId) => ({ invoiceId })),
        };
      }

      if (dto.imageUrls) {
        await tx.packingLoadingImage.deleteMany({
          where: { packingLoadingId: id },
        });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({ imageUrl: url })),
        };
      }

      return tx.packingLoading.update({
        where: { id },
        data: updateData,
        include: {
          branch: true,
          creator: true,
          loadingBy: true,
          invoices: { include: { invoice: true } },
          images: true,
        },
      });
    });

    // Audit log ngoài transaction
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'PACKING_LOADING_UPDATE',
        entityType: 'packing_loadings',
        entityId: id.toString(),
        entityCode: packingLoading.code,
        category: getCategoryFromActionCode('PACKING_LOADING_CREATE'),
        severity: getSeverityFromActionCode('PACKING_LOADING_CREATE'),
        snapshot: this.buildPackingLoadingSnapshot(updated),
        message: `Cập nhật phiếu xếp hàng lên xe ${packingLoading.code}`,
        messageTemplate: 'PACKING_LOADING_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingLoading.branchId || undefined,
      });
    }

    return updated;
  }

  async remove(id: number, userId?: number) {
    const packingLoading = await this.findOne(id);

    const invoiceIds: number[] = (packingLoading.invoices || [])
      .map((i: any) => i.invoiceId)
      .filter((v: any) => v != null);
    const consignmentIds: number[] = (packingLoading.invoices || [])
      .map((i: any) => i.consignmentId)
      .filter((v: any) => v != null);

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      if (invoiceIds.length > 0) {
        await assertCanCancelPacking(tx, invoiceIds, 'loading', id);
      }

      await tx.packingLoading.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelledById: userId ?? null },
      });

      if (invoiceIds.length > 0) {
        await recalcInvoiceStatusAfterPackingCancel(tx, invoiceIds);
      }
      if (consignmentIds.length > 0) {
        const touched = await recalcConsignmentStatusAfterPackingCancel(
          tx,
          consignmentIds,
        );
        for (const productId of touched) touchedProductIds.add(productId);
      }
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PACKING_LOADING_DELETE',
        entityType: 'packing_loadings',
        entityId: id.toString(),
        entityCode: packingLoading.code,
        category: getCategoryFromActionCode('PACKING_LOADING_DELETE'),
        severity: getSeverityFromActionCode('PACKING_LOADING_DELETE'),
        snapshot: this.buildPackingLoadingSnapshot(packingLoading),
        message: renderAuditMessage('PACKING_LOADING_DELETE', {
          packingCode: packingLoading.code,
        }),
        messageTemplate: 'PACKING_LOADING_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingLoading.branchId || undefined,
      });
    }

    return { message: 'Hủy phiếu xếp hàng lên xe thành công' };
  }

  private async generateCode(tx: any): Promise<string> {
    const lastPackingLoading = await tx.packingLoading.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastPackingLoading) {
      const match = lastPackingLoading.code.match(/DLD(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `DLD${nextNumber.toString().padStart(6, '0')}`;
  }

  private buildPackingLoadingSnapshot(pl: any) {
    return {
      code: pl.code,
      branchId: pl.branchId,
      branchName: pl.branch?.name,
      loadingByName: pl.loadingBy?.name,
      numberOfPackages: pl.numberOfPackages,
      note: pl.note,
      invoices: (pl.invoices || []).map((i: any) => ({
        invoiceId: i.invoiceId,
        invoiceCode: i.invoice?.code,
      })),
    };
  }
}
