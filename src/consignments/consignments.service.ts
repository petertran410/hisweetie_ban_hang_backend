import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateConsignmentDto,
  UpdateConsignmentDto,
  ConsignmentQueryDto,
  CancelConsignmentDto,
} from './dto';
import {
  convertStatusStringToNumber,
  getStatusLabel,
  CONSIGNMENT_STATUS,
} from './dto/consignment-status.constants';
import { searchCustomerIds } from '../common/customer-search.util';
import { restoreConsignmentStock } from '../common/consignment-packing.util';
import { resolveDeliveryAddress } from '../common/address-resolver.util';
import { CONSIGNMENT_RETURN_STATUS } from '../consignment-returns/dto';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';

/**
 * Phiếu ký gửi.
 * B1: tạo (PENDING) / xác nhận (CONFIRMED) — KHÔNG trừ kho, KHÔNG tính công nợ.
 * B2: xử lý kho (PACKED/LOADING/DELIVERED) — trừ kho thật 1 lần tại PACKED.
 * B3: xuất hóa đơn (xem InvoicesService.createFromConsignment) — lúc đó mới
 *     tính công nợ; trạng thái phiếu chuyển PARTIALLY_INVOICED/COMPLETED qua
 *     updateConsignmentStatusByInvoices().
 */
@Injectable()
export class ConsignmentsService {
  constructor(
    private prisma: PrismaService,
    private larkProductSync: LarkProductSyncService,
    private auditLogsService: AuditLogsService,
  ) {}

  async create(dto: CreateConsignmentDto, userId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const consignStatusString = dto.consignStatus || 'pending';
      const statusNumber = convertStatusStringToNumber(consignStatusString);
      // B1 chỉ cho phép tạo ở PENDING hoặc CONFIRMED.
      if (
        statusNumber !== CONSIGNMENT_STATUS.PENDING &&
        statusNumber !== CONSIGNMENT_STATUS.CONFIRMED
      ) {
        throw new BadRequestException(
          'Phiếu ký gửi chỉ được tạo ở trạng thái Phiếu tạm hoặc Đã xác nhận',
        );
      }

      if (!dto.branchId) {
        throw new BadRequestException('Branch ID is required');
      }
      const branchId = dto.branchId;

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          if (!product)
            throw new BadRequestException(
              `Product ${item.productId} not found`,
            );

          const discount = item.discount || 0;
          const discountRatio = item.discountRatio || 0;
          const unitPrice = item.unitPrice;
          const totalPrice =
            (unitPrice - discount) * item.quantity -
            (unitPrice * item.quantity * discountRatio) / 100;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price: unitPrice,
            discount,
            discountRatio,
            totalPrice,
            note: item.note || null,
          };
        }),
      );

      const priceBook =
        dto.priceBookId && dto.priceBookId > 0
          ? await tx.priceBook.findFirst({
              where: { id: dto.priceBookId, isActive: true },
            })
          : null;

      const code = await this.generateCode();

      // Snapshot địa chỉ cũ (3 cấp) + mới (2 cấp) từ customer_addresses để shipper xem cả hai.
      const consignAddrSnapshot = await resolveDeliveryAddress(
        tx,
        dto.customerId,
      );

      const consignment = await tx.consignment.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          priceBookId: priceBook?.id || null,
          priceBookName: priceBook?.name || null,
          consignDate: dto.consignDate ? new Date(dto.consignDate) : new Date(),
          status: statusNumber,
          statusValue: getStatusLabel(statusNumber),
          consignStatus: consignStatusString,
          discount: dto.discountAmount || 0,
          discountRatio: dto.discountRatio || 0,
          description: dto.description,
          createdBy: userId,
          items: { createMany: { data: itemsData } },
          delivery: dto.delivery
            ? {
                create: {
                  receiver: dto.delivery.receiver || '',
                  contactNumber: dto.delivery.contactNumber || '',
                  address: dto.delivery.address || '',
                  locationName: dto.delivery.locationName,
                  wardName: dto.delivery.wardName,
                  oldCityName: consignAddrSnapshot.oldCityName,
                  oldDistrictName: consignAddrSnapshot.oldDistrictName,
                  oldWardName: consignAddrSnapshot.oldWardName,
                  newCityName: consignAddrSnapshot.newCityName,
                  newWardName: consignAddrSnapshot.newWardName,
                  weight: dto.delivery.weight,
                  weightUnit: dto.delivery.weightUnit || 'g',
                  length: dto.delivery.length,
                  width: dto.delivery.width,
                  height: dto.delivery.height,
                  noteForDriver: dto.delivery.noteForDriver,
                },
              }
            : undefined,
        },
        include: { items: true },
      });

      await this.calculateTotals(consignment.id, tx);

      return tx.consignment.findUnique({
        where: { id: consignment.id },
        include: { items: true },
      });
    });

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai tạo phiếu ký gửi).
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
        actionCode: 'CONSIGNMENT_CREATE',
        entityType: 'consignments',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode('CONSIGNMENT_CREATE'),
        severity: getSeverityFromActionCode('CONSIGNMENT_CREATE'),
        snapshot: {
          code: result.code,
          status: result.status,
          statusValue: result.statusValue,
          items: result.items?.map((i: any) => ({
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
            price: i.price,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_CREATE', {
          consignmentCode: result.code,
          customerName: customer?.name || '',
        }),
        messageTemplate: 'CONSIGNMENT_CREATE',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  async update(id: number, dto: UpdateConsignmentDto, userId: number) {
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.consignment.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Không tìm thấy phiếu ký gửi');
      if (existing.status === CONSIGNMENT_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu ký gửi đã hủy');
      }
      // Sau khi đã xử lý kho (trừ tồn), không cho sửa dòng hàng để tránh lệch kho.
      if (dto.items && existing.status >= CONSIGNMENT_STATUS.PACKED) {
        throw new BadRequestException(
          'Phiếu đã xử lý kho — không thể sửa danh sách sản phẩm',
        );
      }

      const updateData: any = {};
      if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
      if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
      if (dto.saleChannelId !== undefined)
        updateData.saleChannelId = dto.saleChannelId;
      if (dto.consignDate !== undefined)
        updateData.consignDate = new Date(dto.consignDate);
      if (dto.discountAmount !== undefined)
        updateData.discount = dto.discountAmount;
      if (dto.discountRatio !== undefined)
        updateData.discountRatio = dto.discountRatio;
      if (dto.description !== undefined)
        updateData.description = dto.description;

      // B1: cho phép chuyển PENDING <-> CONFIRMED qua consignStatus.
      if (dto.consignStatus) {
        const statusNumber = convertStatusStringToNumber(dto.consignStatus);
        if (
          statusNumber !== CONSIGNMENT_STATUS.PENDING &&
          statusNumber !== CONSIGNMENT_STATUS.CONFIRMED
        ) {
          throw new BadRequestException(
            'Chỉ được đổi giữa Phiếu tạm và Đã xác nhận ở bước này',
          );
        }
        if (existing.status >= CONSIGNMENT_STATUS.PACKED) {
          throw new BadRequestException(
            'Phiếu đã xử lý kho — không thể đổi về trạng thái này',
          );
        }
        updateData.status = statusNumber;
        updateData.statusValue = getStatusLabel(statusNumber);
        updateData.consignStatus = dto.consignStatus;
      }

      if (dto.items) {
        await tx.consignmentItem.deleteMany({ where: { consignmentId: id } });
        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });
            if (!product)
              throw new BadRequestException(
                `Product ${item.productId} not found`,
              );
            const discount = item.discount || 0;
            const discountRatio = item.discountRatio || 0;
            const unitPrice = item.unitPrice;
            const totalPrice =
              (unitPrice - discount) * item.quantity -
              (unitPrice * item.quantity * discountRatio) / 100;
            return {
              consignmentId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price: unitPrice,
              discount,
              discountRatio,
              totalPrice,
              note: item.note || null,
            };
          }),
        );
        await tx.consignmentItem.createMany({ data: itemsData });
      }

      await tx.consignment.update({ where: { id }, data: updateData });

      if (dto.delivery) {
        // Snapshot địa chỉ cũ+mới theo customerId (ưu tiên dto, fallback existing).
        const updCustomerId =
          dto.customerId !== undefined ? dto.customerId : existing.customerId;
        const updAddrSnapshot = await resolveDeliveryAddress(tx, updCustomerId);
        const deliveryData = {
          receiver: dto.delivery.receiver || '',
          contactNumber: dto.delivery.contactNumber || '',
          address: dto.delivery.address || '',
          locationName: dto.delivery.locationName,
          wardName: dto.delivery.wardName,
          oldCityName: updAddrSnapshot.oldCityName,
          oldDistrictName: updAddrSnapshot.oldDistrictName,
          oldWardName: updAddrSnapshot.oldWardName,
          newCityName: updAddrSnapshot.newCityName,
          newWardName: updAddrSnapshot.newWardName,
          weight: dto.delivery.weight,
          weightUnit: dto.delivery.weightUnit || 'g',
          length: dto.delivery.length,
          width: dto.delivery.width,
          height: dto.delivery.height,
          noteForDriver: dto.delivery.noteForDriver,
        };
        await tx.consignmentDelivery.upsert({
          where: { consignmentId: id },
          create: { consignmentId: id, ...deliveryData },
          update: deliveryData,
        });
      }

      await this.calculateTotals(id, tx);

      return tx.consignment.findUnique({
        where: { id },
        include: { items: true },
      });
    });

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai cập nhật phiếu ký gửi).
    if (result) {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CONSIGNMENT_UPDATE',
        entityType: 'consignments',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode('CONSIGNMENT_UPDATE'),
        severity: getSeverityFromActionCode('CONSIGNMENT_UPDATE'),
        snapshot: {
          code: result.code,
          status: result.status,
          statusValue: result.statusValue,
          items: result.items?.map((i: any) => ({
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
            price: i.price,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_UPDATE', {
          consignmentCode: result.code,
        }),
        messageTemplate: 'CONSIGNMENT_UPDATE',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  /**
   * Danh sách phiếu ký gửi đủ điều kiện để xử lý kho qua phiếu báo đơn
   * (đóng hàng/loading/giao hàng). Lỏng như /invoices/for-packing: chỉ lọc
   * branch + search, loại PENDING/CANCELLED/COMPLETED. Tính toàn vẹn ở write-time.
   */
  async findForPacking(query: {
    branchId?: number;
    pageSize?: number;
    search?: string;
  }) {
    const { branchId, pageSize = 100, search } = query;
    const take = Math.min(Math.max(pageSize, 1), 200);

    const where: any = {
      status: {
        in: [
          CONSIGNMENT_STATUS.CONFIRMED,
          CONSIGNMENT_STATUS.PACKED,
          CONSIGNMENT_STATUS.LOADING,
          CONSIGNMENT_STATUS.DELIVERED,
        ],
      },
    };
    if (branchId) where.branchId = branchId;

    const keyword = search?.trim();
    if (keyword) {
      const matchedIds = await searchCustomerIds(this.prisma, keyword);
      where.OR = [
        { code: { contains: keyword } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }

    const data = await this.prisma.consignment.findMany({
      where,
      select: {
        id: true,
        code: true,
        branchId: true,
        grandTotal: true,
        consignDate: true,
        status: true,
        statusValue: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return { data, total: data.length, page: 1, limit: take };
  }

  /**
   * B3 — recompute trạng thái phiếu theo các hóa đơn con (mirror
   * updateOrderStatusByInvoices + updateOrderSupplierStatus).
   * Số đã xuất HĐ được derive, không lưu cột. Gọi từ InvoicesService sau khi
   * tạo/hủy hóa đơn từ phiếu ký gửi.
   */
  async updateConsignmentStatusByInvoices(consignmentId: number, tx: any) {
    const consignment = await tx.consignment.findUnique({
      where: { id: consignmentId },
      include: { items: true },
    });
    if (!consignment) return;
    // Không hạ cấp phiếu đã hủy / đã chốt hoàn thành thủ công.
    if (
      consignment.status === CONSIGNMENT_STATUS.CANCELLED ||
      consignment.toComplete
    ) {
      return;
    }

    const invoices = await tx.invoice.findMany({
      where: { consignmentId, status: { not: 2 } },
      include: { details: true },
    });

    // Hàng hoàn đã NHẬN VỀ KHO (STOCK_RECEIVED=2). Phần này cũng làm giảm
    // "ký gửi còn lại" giống xuất hóa đơn → tính vào điều kiện COMPLETED.
    const receivedReturns = await tx.consignmentReturn.findMany({
      where: { consignmentId, status: 2 },
      include: { details: true },
    });

    // Chưa có hóa đơn lẫn hàng hoàn về kho -> giữ nguyên trạng thái kho.
    if (invoices.length === 0 && receivedReturns.length === 0) return;

    const invoicedQty: Record<number, number> = {};
    invoices.forEach((inv: any) => {
      inv.details.forEach((d: any) => {
        if (d.productId != null) {
          invoicedQty[d.productId] =
            (invoicedQty[d.productId] || 0) + Number(d.quantity);
        }
      });
    });

    const receivedQty: Record<number, number> = {};
    receivedReturns.forEach((ro: any) => {
      ro.details.forEach((d: any) => {
        if (d.productId != null) {
          receivedQty[d.productId] =
            (receivedQty[d.productId] || 0) + Number(d.returnQuantity);
        }
      });
    });

    // Hoàn tất khi mọi item: đã xuất HĐ + đã hoàn về kho >= SL ký gửi.
    let isFullyResolved = true;
    for (const item of consignment.items) {
      const resolved =
        (invoicedQty[item.productId] || 0) + (receivedQty[item.productId] || 0);
      if (resolved < Number(item.quantity)) {
        isFullyResolved = false;
        break;
      }
    }

    const newStatus = isFullyResolved
      ? CONSIGNMENT_STATUS.COMPLETED
      : CONSIGNMENT_STATUS.PARTIALLY_INVOICED;

    await tx.consignment.update({
      where: { id: consignmentId },
      data: {
        status: newStatus,
        statusValue: getStatusLabel(newStatus),
        consignStatus: isFullyResolved ? 'completed' : 'partially_invoiced',
      },
    });
  }

  async cancel(id: number, dto: CancelConsignmentDto, userId: number) {
    const touchedProductIds = new Set<number>();
    const result = await this.prisma.$transaction(async (tx) => {
      const consignment = await tx.consignment.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!consignment)
        throw new NotFoundException('Không tìm thấy phiếu ký gửi');
      if (consignment.status === CONSIGNMENT_STATUS.CANCELLED) {
        throw new BadRequestException('Phiếu ký gửi đã hủy');
      }

      // Chặn hủy nếu đã xuất hóa đơn (có công nợ phát sinh).
      const activeInvoices = await tx.invoice.count({
        where: { consignmentId: id, status: { not: 2 } },
      });
      if (activeInvoices > 0) {
        throw new BadRequestException(
          'Phiếu đã xuất hóa đơn — không thể hủy. Hãy hủy các hóa đơn liên quan trước.',
        );
      }

      // Chặn hủy nếu còn phiếu báo đơn (đóng hàng/loading/giao hàng) chưa hủy.
      const [activeHang, activeLoading, activeSlip] = await Promise.all([
        tx.packingHangInvoice.count({
          where: { consignmentId: id, packingHang: { cancelledAt: null } },
        }),
        tx.packingLoadingInvoice.count({
          where: { consignmentId: id, packingLoading: { cancelledAt: null } },
        }),
        tx.packingSlipInvoice.count({
          where: { consignmentId: id, packingSlip: { cancelledAt: null } },
        }),
      ]);
      if (activeHang + activeLoading + activeSlip > 0) {
        throw new BadRequestException(
          'Phiếu còn phiếu báo đơn (đóng hàng/loading/giao hàng) chưa hủy. Hãy hủy các phiếu đó trước.',
        );
      }

      // Hoàn kho: xóa các dòng inventoryLog 'CONSIGNMENT_OUT' của phiếu rồi
      // cộng lại onHand (KHÔNG sinh dòng CONSIGNMENT_OUT_CANCEL).
      const touched = await restoreConsignmentStock(tx, id);
      for (const productId of touched) touchedProductIds.add(productId);

      await tx.consignment.update({
        where: { id },
        data: {
          status: CONSIGNMENT_STATUS.CANCELLED,
          statusValue: getStatusLabel(CONSIGNMENT_STATUS.CANCELLED),
          consignStatus: 'cancelled',
          description: dto.reason
            ? `${consignment.description || ''}\n[Hủy] ${dto.reason}`.trim()
            : consignment.description,
        },
      });

      return tx.consignment.findUnique({
        where: { id },
        include: { items: true },
      });
    });

    for (const productId of touchedProductIds) {
      this.larkProductSync.enqueueSync(productId);
    }

    // Ghi audit log sau khi nghiệp vụ đã commit (truy vết ai hủy phiếu ký gửi).
    if (result) {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CONSIGNMENT_CANCEL',
        entityType: 'consignments',
        entityId: result.id.toString(),
        entityCode: result.code,
        category: getCategoryFromActionCode('CONSIGNMENT_CANCEL'),
        severity: getSeverityFromActionCode('CONSIGNMENT_CANCEL'),
        snapshot: {
          code: result.code,
          status: result.status,
          statusValue: result.statusValue,
          reason: dto.reason || null,
          items: result.items?.map((i: any) => ({
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
          })),
        },
        message: renderAuditMessage('CONSIGNMENT_CANCEL', {
          consignmentCode: result.code,
        }),
        messageTemplate: 'CONSIGNMENT_CANCEL',
        userId,
        userName: actorUser?.name || actorUser?.email || 'System',
        branchId: result.branchId || undefined,
      });
    }

    return result;
  }

  private async calculateTotals(consignmentId: number, tx: any) {
    const items = await tx.consignmentItem.findMany({
      where: { consignmentId },
    });
    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.totalPrice),
      0,
    );
    const consignment = await tx.consignment.findUnique({
      where: { id: consignmentId },
    });
    if (!consignment) return;

    const discountAmount =
      Number(consignment.discount) > 0
        ? Number(consignment.discount)
        : (totalAmount * (Number(consignment.discountRatio) || 0)) / 100;
    const grandTotal = totalAmount - discountAmount;

    await tx.consignment.update({
      where: { id: consignmentId },
      data: { totalAmount, grandTotal },
    });
  }

  private async generateCode(): Promise<string> {
    const last = await this.prisma.consignment.findFirst({
      orderBy: { id: 'desc' },
    });
    const nextId = last ? last.id + 1 : 1;
    return `KG${nextId.toString().padStart(6, '0')}`;
  }

  private async buildListWhere(
    query: ConsignmentQueryDto,
    currentUser?: any,
  ): Promise<any> {
    const {
      search,
      status,
      statuses,
      customerId,
      branchId,
      branchIds,
      fromDate,
      toDate,
      soldById,
    } = query;

    const where: any = {};

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    }

    if (search) {
      const matchedIds = await searchCustomerIds(this.prisma, search);
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { customerId: { in: matchedIds.length > 0 ? matchedIds : [-1] } },
      ];
    }
    if (statuses && statuses.length > 0) {
      where.status = {
        in: statuses.map((s) => convertStatusStringToNumber(s)),
      };
    } else if (status) {
      where.status = convertStatusStringToNumber(status);
    }
    if (customerId) where.customerId = customerId;
    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }
    if (soldById) where.soldById = soldById;

    if (fromDate && toDate) {
      where.consignDate = { gte: new Date(fromDate), lte: new Date(toDate) };
    }

    return where;
  }

  async getTotals(query: ConsignmentQueryDto, currentUser?: any) {
    const where = await this.buildListWhere(query, currentUser);
    const agg = await this.prisma.consignment.aggregate({
      where,
      _sum: { totalAmount: true, grandTotal: true },
      _count: { _all: true },
    });
    return {
      count: agg._count._all,
      totalAmount: Number(agg._sum.totalAmount || 0),
      grandTotal: Number(agg._sum.grandTotal || 0),
    };
  }

  async findAll(query: ConsignmentQueryDto, currentUser?: any) {
    const {
      page = 1,
      limit = 10,
      pageSize,
      currentItem,
      orderBy: rawOrderBy,
      orderDirection: rawOrderDirection,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where = await this.buildListWhere(query, currentUser);

    const VALID_ORDER_BY = new Set([
      'consignDate',
      'createdAt',
      'updatedAt',
      'grandTotal',
      'totalAmount',
      'status',
    ]);
    const sortField =
      rawOrderBy && VALID_ORDER_BY.has(rawOrderBy) ? rawOrderBy : 'consignDate';
    const sortDir = rawOrderDirection === 'asc' ? 'asc' : 'desc';

    const [data, total] = await Promise.all([
      this.prisma.consignment.findMany({
        where,
        skip: effectiveSkip,
        take: effectiveLimit,
        include: {
          customer: true,
          soldBy: { select: { id: true, name: true } },
          items: { include: { product: true } },
          invoices: {
            where: { status: { not: 2 } },
            include: { details: true },
          },
          returns: {
            where: { status: { not: 5 } },
            select: {
              id: true,
              code: true,
              status: true,
              details: { select: { productId: true, returnQuantity: true } },
            },
          },
        },
        orderBy: { [sortField]: sortDir },
      }),
      this.prisma.consignment.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.consignment.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
        branch: true,
        soldBy: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: { include: { product: { include: { inventories: true } } } },
        invoices: {
          where: { status: { not: 2 } },
          include: { details: true },
        },
        returns: {
          where: { status: { not: 5 } },
          select: {
            id: true,
            code: true,
            status: true,
            statusValue: true,
            createdAt: true,
            totalReturnQuantity: true,
            details: {
              select: {
                productId: true,
                productCode: true,
                productName: true,
                returnQuantity: true,
                goodQuantity: true,
                damagedQuantity: true,
                nearExpiryQuantity: true,
              },
            },
          },
        },
        delivery: true,
      },
    });
  }

  /**
   * Tổng số lượng đang ký gửi tại khách (đã giao kho, chưa xuất hóa đơn) theo
   * từng product, lọc theo chi nhánh. Dùng cho cột "Ký gửi" ở danh sách SP.
   * = Σ qty các phiếu [PACKED, LOADING, DELIVERED, PARTIALLY_INVOICED]
   *   − Σ qty đã xuất hóa đơn (derive).
   */
  async getConsignmentSummary(productIds: number[], branchId?: number) {
    if (!productIds || productIds.length === 0) {
      return {} as Record<number, number>;
    }

    const where: any = {
      status: {
        in: [
          CONSIGNMENT_STATUS.PACKED,
          CONSIGNMENT_STATUS.LOADING,
          CONSIGNMENT_STATUS.DELIVERED,
          CONSIGNMENT_STATUS.PARTIALLY_INVOICED,
        ],
      },
    };
    if (branchId && !Number.isNaN(branchId)) where.branchId = branchId;

    const consignments = await this.prisma.consignment.findMany({
      where,
      select: {
        items: {
          where: { productId: { in: productIds } },
          select: { productId: true, quantity: true },
        },
        invoices: {
          where: { status: { not: 2 } },
          select: {
            details: {
              where: { productId: { in: productIds } },
              select: { productId: true, quantity: true },
            },
          },
        },
        returns: {
          where: { status: CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED },
          select: {
            details: {
              where: { productId: { in: productIds } },
              select: { productId: true, returnQuantity: true },
            },
          },
        },
      },
    });

    const result: Record<number, number> = {};
    for (const id of productIds) result[id] = 0;

    for (const c of consignments) {
      for (const it of c.items) {
        result[it.productId] =
          (result[it.productId] || 0) + Number(it.quantity);
      }
      for (const inv of c.invoices) {
        for (const d of inv.details) {
          if (d.productId == null) continue;
          result[d.productId] = (result[d.productId] || 0) - Number(d.quantity);
        }
      }
      // Hàng đã hoàn về kho → không còn "đang ở khách".
      for (const r of c.returns) {
        for (const d of r.details) {
          result[d.productId] =
            (result[d.productId] || 0) - Number(d.returnQuantity);
        }
      }
    }

    // Không trả số âm (phòng lệch dữ liệu).
    for (const id of productIds) {
      if (result[id] < 0) result[id] = 0;
    }
    return result;
  }

  /**
   * Chi tiết các phiếu ký gửi đang còn hàng tại khách cho 1 product (cho modal).
   */
  async getConsignmentByProduct(productId: number, branchId?: number) {
    if (!productId || Number.isNaN(productId)) return [];

    const where: any = {
      status: {
        in: [
          CONSIGNMENT_STATUS.PACKED,
          CONSIGNMENT_STATUS.LOADING,
          CONSIGNMENT_STATUS.DELIVERED,
          CONSIGNMENT_STATUS.PARTIALLY_INVOICED,
        ],
      },
      items: { some: { productId } },
    };
    if (branchId && !Number.isNaN(branchId)) where.branchId = branchId;

    const consignments = await this.prisma.consignment.findMany({
      where,
      select: {
        id: true,
        code: true,
        consignDate: true,
        createdAt: true,
        grandTotal: true,
        status: true,
        statusValue: true,
        consignStatus: true,
        customer: { select: { id: true, code: true, name: true } },
        creator: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        items: {
          where: { productId },
          select: { quantity: true },
        },
        invoices: {
          where: { status: { not: 2 } },
          select: {
            details: { where: { productId }, select: { quantity: true } },
          },
        },
        returns: {
          where: { status: CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED },
          select: {
            details: {
              where: { productId },
              select: { returnQuantity: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return consignments
      .map((c) => {
        const consignedQty = c.items.reduce(
          (s, it) => s + Number(it.quantity),
          0,
        );
        const invoicedQty = c.invoices.reduce(
          (s, inv) =>
            s + inv.details.reduce((ss, d) => ss + Number(d.quantity), 0),
          0,
        );
        const returnedQty = c.returns.reduce(
          (s, r) =>
            s + r.details.reduce((ss, d) => ss + Number(d.returnQuantity), 0),
          0,
        );
        const remaining = consignedQty - invoicedQty - returnedQty;
        return {
          consignmentId: c.id,
          code: c.code,
          consignDate: c.consignDate,
          createdAt: c.createdAt,
          grandTotal: Number(c.grandTotal),
          status: c.status,
          statusValue: getStatusLabel(c.status),
          consignStatus: c.consignStatus,
          customer: c.customer,
          creator: c.creator,
          branch: c.branch,
          quantity: remaining,
        };
      })
      .filter((row) => row.quantity > 0);
  }
}
