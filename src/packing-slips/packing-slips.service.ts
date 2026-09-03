import {
  Injectable,
  NotFoundException,
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePackingSlipDto,
  UpdatePackingSlipDto,
  PackingSlipQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { INVOICE_STATUS, getStatusLabel } from 'src/invoices/dto';
import { N8nNotifyService } from '../n8n-notify/n8n-notify.service';
import { LarkExpenseSyncService } from '../lark-sync/services/lark-expense-sync.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import {
  applyPackingToConsignments,
  recalcConsignmentStatusAfterPackingCancel,
} from '../common/consignment-packing.util';
import {
  buildInventoryLogActor,
  InventoryLogActor,
} from '../common/inventory-log.util';
import {
  assertCanCancelPacking,
  recalcInvoiceStatusAfterPackingCancel,
} from '../common/packing-status.util';
import { assertCanDeliverForCustomers } from '../common/debt-delivery.util';

@Injectable()
export class PackingSlipsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private n8nNotifyService: N8nNotifyService,
    private larkExpenseSync: LarkExpenseSyncService,
    private larkProductSync: LarkProductSyncService,
  ) {}

  async findAll(query: PackingSlipQueryDto) {
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
      this.prisma.packingSlip.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          expensePayer: { select: { id: true, name: true, larkUserId: true } },
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
          expenseFiles: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: take,
      }),
      this.prisma.packingSlip.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const packingSlip = await this.prisma.packingSlip.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        expensePayer: { select: { id: true, name: true } },
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
                    code: true,
                    name: true,
                    contactNumber: true,
                  },
                },
                soldBy: {
                  select: {
                    id: true,
                    name: true,
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
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    contactNumber: true,
                  },
                },
                soldBy: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        images: true,
        expenseFiles: true,
      },
    });

    if (!packingSlip) {
      throw new NotFoundException(`Packing slip with ID ${id} not found`);
    }

    return packingSlip;
  }

  async create(dto: CreatePackingSlipDto, userId: number) {
    const isConsignment = !!dto.consignmentIds && dto.consignmentIds.length > 0;
    const touchedProductIds = new Set<number>();

    const packingSlip = await this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

      if (isConsignment) {
        const consignments = await tx.consignment.findMany({
          where: { id: { in: dto.consignmentIds } },
          select: { customerId: true },
        });
        await assertCanDeliverForCustomers(
          tx,
          consignments.map((consignment) => consignment.customerId),
        );
      } else {
        const invoices = await tx.invoice.findMany({
          where: { id: { in: dto.invoiceIds } },
          select: { customerId: true },
        });
        await assertCanDeliverForCustomers(
          tx,
          invoices.map((invoice) => invoice.customerId),
        );
      }

      const created = await tx.packingSlip.create({
        data: {
          code,
          branchId: dto.branchId,
          numberOfPackages: dto.numberOfPackages,
          paymentMethod: dto.paymentMethod,
          cashAmount: dto.cashAmount || 0,
          hasFeeGuiBen: dto.hasFeeGuiBen,
          feeGuiBen: dto.feeGuiBen || 0,
          hasFeeGrab: dto.hasFeeGrab,
          feeGrab: dto.feeGrab || 0,
          hasCuocGuiHang: dto.hasCuocGuiHang,
          cuocGuiHang: dto.cuocGuiHang || 0,
          hasCuocNhanHang: dto.hasCuocNhanHang,
          cuocNhanHang: dto.cuocNhanHang || 0,
          expensePayerId: dto.expensePayerId ?? null,
          note: dto.note,
          createdBy: userId,
          invoices: {
            create: isConsignment
              ? dto.consignmentIds!.map((consignmentId) => ({ consignmentId }))
              : dto.invoiceIds!.map((invoiceId) => ({ invoiceId })),
          },
          images: dto.imageUrls
            ? { create: dto.imageUrls.map((url) => ({ imageUrl: url })) }
            : undefined,
          expenseFiles:
            dto.expenseFiles && dto.expenseFiles.length > 0
              ? {
                  create: dto.expenseFiles.map((f) => ({
                    fileUrl: f.fileUrl,
                    fileName: f.fileName,
                    fileType: f.fileType,
                    fileSize: f.fileSize,
                  })),
                }
              : undefined,
        },
        include: {
          branch: true,
          creator: true,
          expensePayer: true,
          invoices: { include: { invoice: true, consignment: true } },
          images: true,
          expenseFiles: true,
        },
      });

      if (isConsignment) {
        // Giao hàng → DELIVERED (+ trừ kho lần đầu rời CONFIRMED)
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
          'giao-hang',
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
            packingType: 'giao-hang',
            consignmentIds: dto.consignmentIds,
            productCount: touched.size,
          },
          message: renderAuditMessage('CONSIGNMENT_STOCK_OUT', {
            consignmentCode: created.code,
            productCount: touched.size,
          }),
          messageTemplate: 'CONSIGNMENT_STOCK_OUT',
          userId,
          userName:
            consignActorUser?.name || consignActorUser?.email || 'System',
          branchId: created.branchId || undefined,
        });
      } else {
        await tx.invoice.updateMany({
          where: {
            id: { in: dto.invoiceIds },
            status: {
              notIn: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.COMPLETED],
            },
          },
          data: {
            status: INVOICE_STATUS.DELIVERED,
            statusValue: getStatusLabel(INVOICE_STATUS.DELIVERED),
          },
        });

        // Mốc GIAO HÀNG ĐẦU TIÊN — gốc tính hạn công nợ.
        // Điều kiện `deliveredAt: null` là CỐ Ý: một hóa đơn có thể được giao
        // làm nhiều đợt (nhiều phiếu giao chưa hủy). Nếu ghi đè mỗi lần tạo
        // phiếu thì lần giao sau sẽ đẩy lùi hạn nợ, khách được nợ lâu hơn
        // thực tế. Luôn giữ lần giao sớm nhất.
        //
        // CHỈ loại CANCELLED (khác với updateMany status ở trên còn loại
        // COMPLETED). Hóa đơn ở trạng thái COMPLETED vẫn phải mang mốc báo
        // đơn: trạng thái xử lý hóa đơn không thay đổi sự thật là hàng đã được
        // giao. Thiếu mốc này thì ageing coi là "chưa báo đơn" và không đếm hạn.
        // Khi hủy phiếu, giá trị này được tính lại ở
        // recalcInvoiceStatusAfterPackingCancel (common/packing-status.util.ts).
        await tx.invoice.updateMany({
          where: {
            id: { in: dto.invoiceIds },
            deliveredAt: null,
            status: { notIn: [INVOICE_STATUS.CANCELLED] },
          },
          data: { deliveredAt: created.createdAt },
        });
      }

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
      actionCode: 'PACKING_SLIP_CREATE',
      entityType: 'packing_slips',
      entityId: packingSlip.id.toString(),
      entityCode: packingSlip.code,
      category: getCategoryFromActionCode('PACKING_SLIP_CREATE'),
      severity: getSeverityFromActionCode('PACKING_SLIP_CREATE'),
      snapshot: this.buildPackingSlipSnapshot(packingSlip),
      message: renderAuditMessage('PACKING_SLIP_CREATE', {
        packingCode: packingSlip.code,
      }),
      messageTemplate: 'PACKING_SLIP_CREATE',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: packingSlip.branchId || undefined,
    });

    // Notify n8n webhook để gửi tin nhắn Zalo "Báo đơn giao hàng thành công".
    // Lấy lại bản đầy đủ relation (đặc biệt là invoice.customer/consignment.customer)
    // để build payload.
    try {
      const fullPackingSlip = await this.findOne(packingSlip.id);
      const hasConsignments = (fullPackingSlip.invoices || []).some(
        (item: any) => item.consignmentId != null,
      );

      if (hasConsignments) {
        // Ký gửi luôn đi vào workflow/group Zalo ký gửi riêng, kể cả khách Bibi.
        void this.n8nNotifyService
          .notifyConsignmentDelivery(fullPackingSlip as any)
          .catch((err) => {
            console.error('notifyConsignmentDelivery unexpected error:', err);
          });
      } else {
        // Routing loại trừ: phiếu có hóa đơn của khách Bibi → chỉ gửi luồng Bibi.
        if (this.n8nNotifyService.isBibiPackingSlip(fullPackingSlip as any)) {
          void this.n8nNotifyService
            .notifyBibiDelivery(fullPackingSlip as any)
            .catch((err) => {
              console.error('notifyBibiDelivery unexpected error:', err);
            });
        } else {
          void this.n8nNotifyService
            .notifyDelivery(fullPackingSlip as any)
            .catch((err) => {
              console.error('notifyDelivery unexpected error:', err);
            });
        }

        // Sync phiếu chi sang Lark Base "Quản lý Tài chính" (HN/SG).
        void this.larkExpenseSync
          .syncPackingSlipExpenses(fullPackingSlip as any)
          .catch((err) => {
            console.error('larkExpenseSync unexpected error:', err);
          });
      }
    } catch (err) {
      console.error(
        'Failed to load packing slip for n8n notify:',
        (err as Error).message,
      );
    }

    return packingSlip;
  }

  async update(id: number, dto: UpdatePackingSlipDto, userId?: number) {
    const packingSlip = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updateData: any = {
        branchId: dto.branchId,
        numberOfPackages: dto.numberOfPackages,
        paymentMethod: dto.paymentMethod,
        cashAmount: dto.cashAmount || 0,
        hasFeeGuiBen: dto.hasFeeGuiBen,
        feeGuiBen: dto.feeGuiBen || 0,
        hasFeeGrab: dto.hasFeeGrab,
        feeGrab: dto.feeGrab || 0,
        hasCuocGuiHang: dto.hasCuocGuiHang,
        cuocGuiHang: dto.cuocGuiHang || 0,
        hasCuocNhanHang: dto.hasCuocNhanHang,
        cuocNhanHang: dto.cuocNhanHang || 0,
        note: dto.note,
      };

      if ('expensePayerId' in dto) {
        updateData.expensePayerId = dto.expensePayerId ?? null;
      }

      if (dto.invoiceIds || dto.consignmentIds) {
        // Hóa đơn bị BỎ khỏi phiếu (có trước, không còn trong payload).
        const previousInvoiceIds = (packingSlip.invoices || [])
          .map((row: any) => row.invoiceId)
          .filter(
            (invoiceId: number | null): invoiceId is number => !!invoiceId,
          );
        const nextInvoiceIds = new Set(dto.invoiceIds ?? []);
        const removedInvoiceIds = previousInvoiceIds.filter(
          (invoiceId) => !nextInvoiceIds.has(invoiceId),
        );

        if (dto.invoiceIds && dto.invoiceIds.length > 0) {
          const invoices = await tx.invoice.findMany({
            where: { id: { in: dto.invoiceIds } },
            select: { customerId: true },
          });
          await assertCanDeliverForCustomers(
            tx,
            invoices.map((invoice) => invoice.customerId),
          );
        }
        if (dto.consignmentIds && dto.consignmentIds.length > 0) {
          const consignments = await tx.consignment.findMany({
            where: { id: { in: dto.consignmentIds } },
            select: { customerId: true },
          });
          await assertCanDeliverForCustomers(
            tx,
            consignments.map((consignment) => consignment.customerId),
          );
        }

        await tx.packingSlipInvoice.deleteMany({
          where: { packingSlipId: id },
        });
        updateData.invoices = {
          create: dto.consignmentIds
            ? dto.consignmentIds.map((consignmentId) => ({ consignmentId }))
            : (dto.invoiceIds || []).map((invoiceId) => ({ invoiceId })),
        };

        // Hóa đơn mới được THÊM vào phiếu giao hàng qua bước sửa cũng là "báo
        // đơn thành công" → phải set DELIVERED và stamp mốc công nợ giống lúc
        // tạo phiếu, nếu không thì hạn nợ không bao giờ khởi động cho các hóa
        // đơn này. Chỉ áp dụng cho phiếu giao hàng (không phải ký gửi).
        if (dto.invoiceIds && dto.invoiceIds.length > 0) {
          await tx.invoice.updateMany({
            where: {
              id: { in: dto.invoiceIds },
              status: {
                notIn: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.COMPLETED],
              },
            },
            data: {
              status: INVOICE_STATUS.DELIVERED,
              statusValue: getStatusLabel(INVOICE_STATUS.DELIVERED),
            },
          });
          await tx.invoice.updateMany({
            where: {
              id: { in: dto.invoiceIds },
              deliveredAt: null,
              status: { notIn: [INVOICE_STATUS.CANCELLED] },
            },
            data: { deliveredAt: packingSlip.createdAt },
          });
        }

        // Hóa đơn bị bỏ khỏi phiếu: tính lại trạng thái + mốc công nợ theo các
        // phiếu còn hiệu lực (dùng chung helper với luồng hủy phiếu). Không làm
        // bước này thì hóa đơn vẫn mang mốc giao hàng của phiếu đã rời ⇒ bị
        // tính hạn nợ oan.
        if (removedInvoiceIds.length > 0) {
          await recalcInvoiceStatusAfterPackingCancel(tx, removedInvoiceIds);
        }
      }

      if (dto.imageUrls) {
        await tx.packingSlipImage.deleteMany({ where: { packingSlipId: id } });
        updateData.images = {
          create: dto.imageUrls.map((url) => ({ imageUrl: url })),
        };
      }

      if (dto.expenseFiles) {
        await tx.packingSlipExpenseFile.deleteMany({
          where: { packingSlipId: id },
        });
        if (dto.expenseFiles.length > 0) {
          updateData.expenseFiles = {
            create: dto.expenseFiles.map((f) => ({
              fileUrl: f.fileUrl,
              fileName: f.fileName,
              fileType: f.fileType,
              fileSize: f.fileSize,
            })),
          };
        }
      }

      return tx.packingSlip.update({
        where: { id },
        data: updateData,
        include: {
          branch: true,
          creator: true,
          expensePayer: true,
          invoices: { include: { invoice: true } },
          images: true,
          expenseFiles: true,
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
        actionCode: 'PACKING_SLIP_UPDATE',
        entityType: 'packing_slips',
        entityId: id.toString(),
        entityCode: packingSlip.code,
        category: getCategoryFromActionCode('PACKING_SLIP_CREATE'),
        severity: getSeverityFromActionCode('PACKING_SLIP_CREATE'),
        snapshot: this.buildPackingSlipSnapshot(updated),
        message: `Cập nhật phiếu đóng hàng ${packingSlip.code}`,
        messageTemplate: 'PACKING_SLIP_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingSlip.branchId || undefined,
      });
    }

    // Nếu một trong các trường quan trọng (hóa đơn, số kiện, hình ảnh,
    // hình thức thanh toán, ghi chú) thay đổi → gửi lại thông báo Zalo qua n8n.
    if (this.hasNotifiableChange(packingSlip, dto)) {
      try {
        const fullPackingSlip = await this.findOne(id);
        const hasConsignments = (fullPackingSlip.invoices || []).some(
          (item: any) => item.consignmentId != null,
        );

        if (hasConsignments) {
          void this.n8nNotifyService
            .notifyConsignmentDelivery(fullPackingSlip as any)
            .catch((err) => {
              console.error(
                'notifyConsignmentDelivery (update) unexpected error:',
                err,
              );
            });
        } else if (
          this.n8nNotifyService.isBibiPackingSlip(fullPackingSlip as any)
        ) {
          void this.n8nNotifyService
            .notifyBibiDelivery(fullPackingSlip as any)
            .catch((err) => {
              console.error(
                'notifyBibiDelivery (update) unexpected error:',
                err,
              );
            });
        } else {
          void this.n8nNotifyService
            .notifyDelivery(fullPackingSlip as any)
            .catch((err) => {
              console.error('notifyDelivery (update) unexpected error:', err);
            });
        }
      } catch (err) {
        console.error(
          'Failed to load packing slip for n8n notify (update):',
          (err as Error).message,
        );
      }
    }

    return updated;
  }

  /**
   * Gửi lại thông báo giao hàng vào Zalo (n8n) một cách thủ công.
   * Khác với auto-trigger: ở đây CHỜ kết quả để báo lỗi rõ ràng cho người dùng.
   */
  async resendDeliveryNotification(id: number) {
    const fullPackingSlip = await this.findOne(id);

    const hasConsignments = (fullPackingSlip.invoices || []).some(
      (item: any) => item.consignmentId != null,
    );
    const isBibi =
      !hasConsignments &&
      this.n8nNotifyService.isBibiPackingSlip(fullPackingSlip as any);

    const result = hasConsignments
      ? await this.n8nNotifyService.notifyConsignmentDelivery(
          fullPackingSlip as any,
        )
      : isBibi
        ? await this.n8nNotifyService.notifyBibiDelivery(fullPackingSlip as any)
        : await this.n8nNotifyService.notifyDelivery(fullPackingSlip as any);

    if (result.skipped) {
      throw new ServiceUnavailableException(
        hasConsignments
          ? 'Webhook ký gửi chưa được cấu hình (N8N_DEPOSIT_WEBHOOK_URL)'
          : isBibi
            ? 'Webhook Bibi chưa được cấu hình (N8N_BIBI_WEBHOOK_URL)'
            : 'Webhook Zalo chưa được cấu hình (N8N_DELIVERY_WEBHOOK_URL)',
      );
    }

    if (!result.ok) {
      throw new BadGatewayException(
        `Gửi tin nhắn thất bại${result.error ? `: ${result.error}` : ''}`,
      );
    }

    return {
      message: hasConsignments
        ? 'Đã gửi lại thông báo ký gửi vào Zalo'
        : isBibi
          ? 'Đã gửi lại thông báo giao hàng (Bibi)'
          : 'Đã gửi lại thông báo giao hàng vào Zalo',
    };
  }

  /**
   * Gửi lại (đồng bộ) phiếu chi lên Lark Base một cách thủ công.
   * Logic upsert nằm trong larkExpenseSync.syncPackingSlipExpenses:
   *   1. Có record_id đã lưu → update.
   *   2. Chưa có → search theo "Mã Báo Đơn" trên Lark → update nếu thấy.
   *   3. Không thấy → tạo mới.
   * CHỜ kết quả để báo lỗi rõ ràng cho người dùng (khác auto fire-and-forget).
   */
  async resendLarkExpense(id: number) {
    const fullPackingSlip = await this.findOne(id);
    if (!this.larkExpenseSync.isEnabled()) {
      throw new ServiceUnavailableException(
        'Đồng bộ Lark chưa được cấu hình (LARK_EXPENSE_BASE_TOKEN)',
      );
    }
    await this.larkExpenseSync.syncPackingSlipExpenses(fullPackingSlip as any);
    return { message: 'Đã đồng bộ phiếu chi lên Lark' };
  }

  /**
   * Gửi lại thông báo giao hàng Zalo nhưng KHÔNG throw (fire-and-forget).
   * Dùng khi gọi tự động từ flow khác (vd: versioning hóa đơn) để không làm
   * fail nghiệp vụ gốc. Tự nuốt + log mọi lỗi.
   */
  async resendDeliverySafe(id: number): Promise<void> {
    try {
      const fullPackingSlip = await this.findOne(id);
      const hasConsignments = (fullPackingSlip.invoices || []).some(
        (item: any) => item.consignmentId != null,
      );
      const isBibi =
        !hasConsignments &&
        this.n8nNotifyService.isBibiPackingSlip(fullPackingSlip as any);
      const result = hasConsignments
        ? await this.n8nNotifyService.notifyConsignmentDelivery(
            fullPackingSlip as any,
          )
        : isBibi
          ? await this.n8nNotifyService.notifyBibiDelivery(
              fullPackingSlip as any,
            )
          : await this.n8nNotifyService.notifyDelivery(fullPackingSlip as any);
      if (!result.ok && !result.skipped) {
        console.error(
          `resendDeliverySafe: gửi thông báo thất bại cho packing slip id=${id}: ${result.error ?? ''}`,
        );
      }
    } catch (err) {
      console.error(
        `resendDeliverySafe: lỗi khi gửi lại Zalo cho packing slip id=${id}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * So sánh bản cũ (đã include relations) với dto cập nhật để xác định
   * có cần gửi lại Zalo hay không. Chỉ xét các field có mặt trong dto.
   * Các trường được theo dõi: hóa đơn (invoiceIds), số kiện (numberOfPackages),
   * hình ảnh (imageUrls), hình thức thanh toán (paymentMethod + cashAmount),
   * ghi chú (note).
   */
  private hasNotifiableChange(
    oldSlip: any,
    dto: UpdatePackingSlipDto,
  ): boolean {
    if (
      dto.numberOfPackages !== undefined &&
      dto.numberOfPackages !== oldSlip.numberOfPackages
    ) {
      return true;
    }

    if (
      dto.paymentMethod !== undefined &&
      dto.paymentMethod !== oldSlip.paymentMethod
    ) {
      return true;
    }

    if (
      dto.cashAmount !== undefined &&
      Number(dto.cashAmount) !== Number(oldSlip.cashAmount ?? 0)
    ) {
      return true;
    }

    if (dto.note !== undefined && (dto.note ?? '') !== (oldSlip.note ?? '')) {
      return true;
    }

    if (
      dto.imageUrls !== undefined &&
      this.hasArrayChanged(
        dto.imageUrls,
        (oldSlip.images || []).map((img: any) => img.imageUrl),
      )
    ) {
      return true;
    }

    if (
      dto.invoiceIds !== undefined &&
      this.hasArrayChanged(
        dto.invoiceIds,
        (oldSlip.invoices || []).map((inv: any) => inv.invoiceId),
      )
    ) {
      return true;
    }

    if (
      dto.consignmentIds !== undefined &&
      this.hasArrayChanged(
        dto.consignmentIds,
        (oldSlip.invoices || []).map((inv: any) => inv.consignmentId),
      )
    ) {
      return true;
    }

    return false;
  }

  /** So sánh 2 mảng dạng tập hợp (không quan tâm thứ tự, loại trùng). */
  private hasArrayChanged(next: any[], prev: any[]): boolean {
    const a = new Set((next || []).map((v) => String(v)));
    const b = new Set((prev || []).map((v) => String(v)));
    if (a.size !== b.size) return true;
    for (const v of a) {
      if (!b.has(v)) return true;
    }
    return false;
  }

  async remove(id: number, userId?: number) {
    const packingSlip = await this.findOne(id);

    const invoiceIds: number[] = (packingSlip.invoices || [])
      .map((i: any) => i.invoiceId)
      .filter((v: any) => v != null);
    const consignmentIds: number[] = (packingSlip.invoices || [])
      .map((i: any) => i.consignmentId)
      .filter((v: any) => v != null);

    const touchedProductIds = new Set<number>();

    await this.prisma.$transaction(async (tx) => {
      // Chặn hủy nếu có hóa đơn đã hủy / sai thứ tự bậc
      if (invoiceIds.length > 0) {
        await assertCanCancelPacking(tx, invoiceIds, 'giao-hang', id);
      }

      // Soft-cancel: giữ dữ liệu, đánh dấu đã hủy + ai hủy
      await tx.packingSlip.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelledById: userId ?? null },
      });

      // Hoàn (lùi) trạng thái hóa đơn về bậc cao nhất còn lại
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
        actionCode: 'PACKING_SLIP_DELETE',
        entityType: 'packing_slips',
        entityId: id.toString(),
        entityCode: packingSlip.code,
        category: getCategoryFromActionCode('PACKING_SLIP_DELETE'),
        severity: getSeverityFromActionCode('PACKING_SLIP_DELETE'),
        snapshot: this.buildPackingSlipSnapshot(packingSlip),
        message: renderAuditMessage('PACKING_SLIP_DELETE', {
          packingCode: packingSlip.code,
        }),
        messageTemplate: 'PACKING_SLIP_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: packingSlip.branchId || undefined,
      });
    }

    return { message: 'Hủy phiếu giao hàng thành công' };
  }

  private async generateCode(tx: any): Promise<string> {
    const lastPackingSlip = await tx.packingSlip.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastPackingSlip) {
      const match = lastPackingSlip.code.match(/BD(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }

    return `BD${nextNumber.toString().padStart(6, '0')}`;
  }

  private buildPackingSlipSnapshot(ps: any) {
    return {
      code: ps.code,
      branchId: ps.branchId,
      branchName: ps.branch?.name,
      numberOfPackages: ps.numberOfPackages,
      paymentMethod: ps.paymentMethod,
      cashAmount: Number(ps.cashAmount || 0),
      feeGuiBen: Number(ps.feeGuiBen || 0),
      feeGrab: Number(ps.feeGrab || 0),
      cuocGuiHang: Number(ps.cuocGuiHang || 0),
      cuocNhanHang: Number(ps.cuocNhanHang || 0),
      note: ps.note,
      invoices: (ps.invoices || []).map((i: any) => ({
        invoiceId: i.invoiceId,
        invoiceCode: i.invoice?.code,
      })),
    };
  }
}
