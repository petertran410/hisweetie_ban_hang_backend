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
import {
  applyPackingToConsignments,
  recalcConsignmentStatusAfterPackingCancel,
} from '../common/consignment-packing.util';
import {
  assertCanCancelPacking,
  recalcInvoiceStatusAfterPackingCancel,
} from '../common/packing-status.util';

@Injectable()
export class PackingSlipsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
    private n8nNotifyService: N8nNotifyService,
    private larkExpenseSync: LarkExpenseSyncService,
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
    const isConsignment =
      !!dto.consignmentIds && dto.consignmentIds.length > 0;

    const packingSlip = await this.prisma.$transaction(async (tx) => {
      const code = await this.generateCode(tx);

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
        await applyPackingToConsignments(tx, dto.consignmentIds!, 'giao-hang');
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
      }

      return created;
    });

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
    // Lấy lại bản đầy đủ relation (đặc biệt là invoice.customer) để build payload.
    // Bỏ qua với phiếu ký gửi (không có hóa đơn để thông báo).
    if (!isConsignment) {
      try {
        const fullPackingSlip = await this.findOne(packingSlip.id);
      // Không await để response API tạo packing slip không bị chờ webhook.
      // notifyDelivery đã tự nuốt lỗi bên trong, nhưng vẫn bọc thêm để chắc.
      void this.n8nNotifyService
        .notifyDelivery(fullPackingSlip as any)
        .catch((err) => {
          // Phòng ngừa, dù service đã tự log

          console.error('notifyDelivery unexpected error:', err);
        });

      // Sync phiếu chi sang Lark Base "Quản lý Tài chính" (HN/SG).
      // Best-effort: lỗi ở đây không ảnh hưởng response.
      void this.larkExpenseSync
        .syncPackingSlipExpenses(fullPackingSlip as any)
        .catch((err) => {
          console.error('larkExpenseSync unexpected error:', err);
        });
    } catch (err) {
        console.error(
          'Failed to load packing slip for n8n notify:',
          (err as Error).message,
        );
      }
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

      if (dto.invoiceIds) {
        await tx.packingSlipInvoice.deleteMany({
          where: { packingSlipId: id },
        });
        updateData.invoices = {
          create: dto.invoiceIds.map((invoiceId) => ({ invoiceId })),
        };
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
        // Fire-and-forget: không chặn response cập nhật.
        void this.n8nNotifyService
          .notifyDelivery(fullPackingSlip as any)
          .catch((err) => {
            console.error('notifyDelivery (update) unexpected error:', err);
          });
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
    const result = await this.n8nNotifyService.notifyDelivery(
      fullPackingSlip as any,
    );

    if (result.skipped) {
      throw new ServiceUnavailableException(
        'Webhook Zalo chưa được cấu hình (N8N_DELIVERY_WEBHOOK_URL)',
      );
    }

    if (!result.ok) {
      throw new BadGatewayException(
        `Gửi tin nhắn Zalo thất bại${result.error ? `: ${result.error}` : ''}`,
      );
    }

    return { message: 'Đã gửi lại thông báo giao hàng vào Zalo' };
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
      const result = await this.n8nNotifyService.notifyDelivery(
        fullPackingSlip as any,
      );
      if (!result.ok && !result.skipped) {
        console.error(
          `resendDeliverySafe: gửi Zalo thất bại cho packing slip id=${id}: ${result.error ?? ''}`,
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
        await recalcConsignmentStatusAfterPackingCancel(tx, consignmentIds);
      }
    });

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
