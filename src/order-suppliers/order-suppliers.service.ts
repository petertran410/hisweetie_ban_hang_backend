import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CancelOrderSupplierDto,
  CreateOrderSupplierDto,
  UpdateOrderSupplierDto,
  OrderSupplierQueryDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { recalcSupplierDebt } from '../common/supplier-debt.util';
import { buildChanges, buildItemChanges } from '../audit-logs/audit-diff.utils';

/**
 * Bảng nhãn status của OrderSupplier (PDN). Đối xứng `getStatusLabel` của
 * `OrderSupplier` ở frontend (`pos-hisweetie/lib/types/order-supplier.ts`).
 *
 *   0 DRAFT     - Phiếu tạm
 *   1 CONFIRMED - Đã xác nhận NCC
 *   2 PARTIAL   - Nhập một phần
 *   3 COMPLETED - Hoàn thành
 *   4 CANCELLED - Đã hủy
 */
function getOrderSupplierStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Phiếu tạm';
    case 1:
      return 'Đã xác nhận NCC';
    case 2:
      return 'Nhập một phần';
    case 3:
      return 'Hoàn thành';
    case 4:
      return 'Đã hủy';
    default:
      return 'Không xác định';
  }
}

@Injectable()
export class OrderSuppliersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  /**
   * Dựng điều kiện `where` cho PĐN. Tách riêng để dùng chung giữa findAll,
   * getDetailItems và export/export-detail — đảm bảo bộ lọc xuất file khớp
   * hoàn toàn với bộ lọc đang hiển thị trên UI.
   */
  private buildOrderSupplierWhere(
    query: OrderSupplierQueryDto,
    supplierScope?: number | null,
  ): any {
    const {
      branchId,
      branchIds,
      supplierId,
      status,
      createdById,
      userId,
      createdDateFrom,
      createdDateTo,
      search,
    } = query;

    const where: any = {};

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
        { supplier: { code: { contains: search, mode: 'insensitive' } } },
        {
          items: {
            some: {
              OR: [
                { productCode: { contains: search, mode: 'insensitive' } },
                { productName: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }
    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }
    if (supplierId) where.supplierId = supplierId;
    if (status !== undefined && status.length > 0) {
      where.status = status.length === 1 ? status[0] : { in: status };
    }
    if (createdById) where.createdBy = createdById;
    if (userId) where.userId = userId;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        where.createdAt.lte = new Date(createdDateTo);
      }
    }

    // Scope NCC: ép theo NCC của user (ghi đè mọi supplierId từ query).
    if (supplierScope != null) where.supplierId = supplierScope;

    return where;
  }

  async findAll(query: OrderSupplierQueryDto, supplierScope?: number | null) {
    const { pageSize = 15, currentItem = 0 } = query;
    const where = this.buildOrderSupplierWhere(query, supplierScope);

    const [data, total] = await Promise.all([
      this.prisma.orderSupplier.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          supplier: {
            select: {
              id: true,
              code: true,
              name: true,
              contactNumber: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          items: true,
          expensesOthers: true,
          purchaseOrders: {
            select: {
              id: true,
              code: true,
            },
            orderBy: {
              createdAt: 'asc',
            },
          },
          // Cần foreignAmount để FE list tính "Đã trả / Cần trả NCC" (CNY)
          // đúng khi tỉ giá TT ≠ tỉ giá phiếu — mirror PurchaseOrder list.
          payments: {
            where: { status: { not: 2 } },
            select: {
              id: true,
              amount: true,
              foreignAmount: true,
              exchangeRate: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.orderSupplier.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  /**
   * Bảng phẳng tất cả dòng sản phẩm của các PĐN khớp filter — phục vụ trang
   * "Đặt hàng nhập chi tiết". Mỗi dòng = 1 OrderSupplierItem kèm thông tin phiếu
   * (mã PDN, NCC, chi nhánh, trạng thái) và các mốc SL (đặt / đã nhập / còn lại).
   * Filter dùng chung với findAll. Phân trang ở mức dòng sản phẩm.
   */
  async getDetailItems(
    query: OrderSupplierQueryDto,
    supplierScope?: number | null,
  ) {
    const { pageSize = 15, currentItem = 0, search } = query;
    const where = this.buildOrderSupplierWhere(query, supplierScope);

    const orderSuppliers = await this.prisma.orderSupplier.findMany({
      where,
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              select: {
                kiotVietId: true,
                weight: true,
                weightUnit: true,
                parentName: true,
                middleName: true,
                childName: true,
                tradeMark: { select: { name: true } },
              },
            },
            productionStage: { select: { id: true, name: true } },
            factory: { select: { id: true, name: true } },
          },
        },
        purchaseOrders: {
          where: { isDraft: false, status: { not: 2 } },
          select: { items: { select: { productId: true, quantity: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Gom DISTINCT Số HĐ + thông tin xe (cửa khẩu, ngày về kho) qua tất cả phiếu
    // ghép xe chưa hủy chứa từng (orderSupplierId, productId). Trước đây chỉ lấy
    // phiếu xe MỚI NHẤT cho mỗi cặp key, làm "nuốt" các Số HĐ khác khi 1 PĐN
    // xuất hiện trên nhiều xe (vd HH00082-26 thuộc HĐ 2026-169 + 2026-197).
    const osIds = orderSuppliers.map((o) => o.id);
    const contractNosByKey = new Map<string, string[]>();
    const vehicleInfoByKey = new Map<
      string,
      {
        borderGateName: string | null;
        expectedArrivalDate: Date | null;
        actualArrivalDate: Date | null;
      }
    >();
    if (osIds.length > 0) {
      const shipItems = await this.prisma.vehicleShipmentItem.findMany({
        where: {
          orderSupplierId: { in: osIds },
          vehicleShipment: { status: { not: 3 } },
        },
        select: {
          orderSupplierId: true,
          productId: true,
          contractNo: true,
          vehicleShipment: {
            select: {
              expectedArrivalDate: true,
              actualArrivalDate: true,
              borderGate: { select: { name: true } },
            },
          },
        },
      });
      for (const si of shipItems) {
        const key = `${si.orderSupplierId}:${si.productId}`;
        if (si.contractNo) {
          const arr = contractNosByKey.get(key) ?? [];
          if (!arr.includes(si.contractNo)) arr.push(si.contractNo);
          contractNosByKey.set(key, arr);
        }
        // borderGate/date dùng lần xuất hiện đầu tiên (không quan trọng thứ tự
        // vì cùng SP cùng PĐN thường đi cùng cửa khẩu + xe).
        if (!vehicleInfoByKey.has(key) && si.vehicleShipment) {
          vehicleInfoByKey.set(key, {
            borderGateName: si.vehicleShipment.borderGate?.name ?? null,
            expectedArrivalDate: si.vehicleShipment.expectedArrivalDate,
            actualArrivalDate: si.vehicleShipment.actualArrivalDate,
          });
        }
      }
    }

    // Nếu có search theo SP, chỉ giữ dòng khớp mã/tên.
    const term = (search || '').trim().toLowerCase();
    const matchProductSearch = (it: any) => {
      if (!term) return true;
      // Khi search khớp ở cấp phiếu (mã PDN/NCC) thì giữ toàn bộ dòng; nếu
      // không, lọc theo mã/tên SP. Ở đây áp lọc SP để bảng phẳng gọn hơn.
      return (
        (it.productCode || '').toLowerCase().includes(term) ||
        (it.productName || '').toLowerCase().includes(term)
      );
    };

    const flat: any[] = [];
    for (const os of orderSuppliers) {
      const receivedByProduct: Record<number, number> = {};
      for (const po of os.purchaseOrders) {
        for (const it of po.items) {
          receivedByProduct[it.productId] =
            (receivedByProduct[it.productId] || 0) + Number(it.quantity);
        }
      }
      // Khi search, nếu khớp ở cấp phiếu (mã PDN/NCC) thì hiển thị mọi dòng.
      const matchHeader =
        !!term &&
        ((os.code || '').toLowerCase().includes(term) ||
          (os.supplier?.name || '').toLowerCase().includes(term) ||
          (os.supplier?.code || '').toLowerCase().includes(term));

      for (const item of os.items) {
        if (term && !matchHeader && !matchProductSearch(item)) continue;
        const ordered = Number(item.quantity);
        const received = receivedByProduct[item.productId] || 0;
        const product = (item as any).product;
        const unitWeight = product?.weight ? Number(product.weight) : 0;
        const unitGram =
          (product?.weightUnit || 'kg').toLowerCase() === 'g'
            ? unitWeight
            : unitWeight * 1000;
        const productGroup = [
          product?.parentName,
          product?.middleName,
          product?.childName,
        ]
          .filter(Boolean)
          .join(' / ');
        const veh = vehicleInfoByKey.get(`${os.id}:${item.productId}`);
        flat.push({
          orderSupplierId: os.id,
          orderSupplierCode: os.code,
          orderDate: os.orderDate,
          status: os.status,
          statusValue: getOrderSupplierStatusLabel(os.status),
          supplier: os.supplier,
          branch: os.branch,
          creator: os.creator,
          productId: item.productId,
          productCode: item.productCode,
          productName: item.productName,
          orderedQty: ordered,
          receivedQty: received,
          remainingQty: Math.max(ordered - received, 0),
          price: Number(item.price),
          discount: Number(item.discount || 0),
          subTotal: Number(item.subTotal),
          factoryPrice:
            item.factoryPrice != null ? Number(item.factoryPrice) : null,
          factorySubTotal:
            item.factorySubTotal != null ? Number(item.factorySubTotal) : null,
          // Phân bổ (từ item)
          allocation: Number(item.allocation || 0),
          allocationSuppliers: Number(item.allocationSuppliers || 0),
          allocationThirdParty: Number(item.allocationThirdParty || 0),
          description: item.description || null,
          // Từ product
          kiotVietId: product?.kiotVietId ? String(product.kiotVietId) : null,
          unitWeightGram: unitGram,
          totalWeightKg: (unitGram * ordered) / 1000,
          tradeMarkName: product?.tradeMark?.name ?? null,
          productGroup: productGroup || null,
          // Giai đoạn hiện tại / nhà máy (master data, gán per dòng)
          productionStageId: (item as any).productionStageId ?? null,
          productionStageName: (item as any).productionStage?.name ?? null,
          factoryId: (item as any).factoryId ?? null,
          factoryName: (item as any).factory?.name ?? null,
          // Từ phiếu ghép xe (gom DISTINCT — 1 dòng item có thể thuộc nhiều Số HĐ)
          borderGateName: veh?.borderGateName ?? null,
          // Giữ `contractNo` (string|null) cho backward-compat với FE cũ —
          // trả về phần tử đầu tiên của danh sách DISTINCT (hoặc null nếu
          // dòng chưa được gán HĐ nào).
          contractNo:
            contractNosByKey.get(`${os.id}:${item.productId}`)?.[0] ?? null,
          contractNos: contractNosByKey.get(`${os.id}:${item.productId}`) ?? [],
          expectedArrivalDate: veh?.expectedArrivalDate ?? null,
          actualArrivalDate: veh?.actualArrivalDate ?? null,
        });
      }
    }

    const total = flat.length;
    const data = flat.slice(currentItem, currentItem + pageSize);
    return { data, total, pageSize, currentItem };
  }

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu đặt hàng nhập = 1 dòng Excel. Bộ lọc dùng
   * chung buildOrderSupplierWhere với danh sách/chi tiết.
   *
   * Cột tài chính (Tổng tiền hàng / Cần trả NCC / Đã trả NCC) ưu tiên CNY +
   * VND phụ khi phiếu NCC nước ngoài (currency='CNY') — đối xứng cách hiển
   * thị ở FE trang danh sách. Các phiếu NCC nội địa xuất 1 cột VND như cũ.
   */
  async exportOrderSuppliers(
    query: OrderSupplierQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildOrderSupplierWhere(query, supplierScope);

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Đặt hàng nhập');

    sheet.columns = [
      { header: 'Mã đặt hàng nhập', key: 'code', width: 18 },
      { header: 'Mã nhập hàng', key: 'purchaseOrderCodes', width: 24 },
      { header: 'Số HĐ', key: 'contractNos', width: 24 },
      { header: 'Ngày dự kiến nhập', key: 'orderDate', width: 20 },
      { header: 'Ngày tạo', key: 'createdAt', width: 20 },
      { header: 'Ngày cập nhật', key: 'updatedAt', width: 20 },
      { header: 'Nhà cung cấp', key: 'supplier', width: 24 },
      { header: 'Mã NCC', key: 'supplierCode', width: 14 },
      { header: 'Chi nhánh', key: 'branch', width: 18 },
      { header: 'Người đặt', key: 'orderBy', width: 18 },
      { header: 'Người tạo', key: 'creator', width: 18 },
      { header: 'Tổng SL', key: 'totalQty', width: 12 },
      { header: 'Số mặt hàng', key: 'productQty', width: 12 },
      { header: 'Loại tiền', key: 'currency', width: 10 },
      { header: 'Tổng tiền hàng (VND)', key: 'totalVnd', width: 18 },
      { header: 'Tổng tiền hàng (CNY)', key: 'totalCny', width: 18 },
      { header: 'Giảm giá (VND)', key: 'discountVnd', width: 16 },
      { header: 'Cần trả NCC (VND)', key: 'supplierDebtVnd', width: 18 },
      { header: 'Cần trả NCC (CNY)', key: 'supplierDebtCny', width: 18 },
      { header: 'Đã trả NCC (VND)', key: 'paidAmountVnd', width: 18 },
      { header: 'Đã trả NCC (CNY)', key: 'paidAmountCny', width: 18 },
      { header: 'Trạng thái', key: 'status', width: 18 },
      { header: 'Ghi chú', key: 'description', width: 28 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.orderSupplier.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { code: true, name: true } },
          branch: { select: { name: true } },
          user: { select: { name: true } },
          creator: { select: { name: true } },
          purchaseOrders: { select: { code: true } },
          items: {
            select: {
              quantity: true,
              factorySubTotal: true,
            },
          },
          vehicleShipmentItems: {
            where: { vehicleShipment: { status: { not: 3 } } },
            select: { contractNo: true },
            distinct: ['contractNo'],
          },
        },
      });

      if (batch.length === 0) break;

      for (const os of batch) {
        const purchaseOrderCodes = (os.purchaseOrders || [])
          .map((po) => po.code)
          .filter(Boolean)
          .join(' | ');
        const contractNos = Array.from(
          new Set(
            (os.vehicleShipmentItems || [])
              .map((v) => v.contractNo)
              .filter(Boolean) as string[],
          ),
        ).join(', ');

        const rate = Number(os.exchangeRate) || 1;
        const isCny = os.currency === 'CNY';

        // Tổng tiền hàng: ưu tiên CNY (factorySubTotal) khi NCC nước ngoài.
        const totalCny = (os.items || []).reduce(
          (s, it) => s + (Math.abs(Number(it.factorySubTotal)) || 0),
          0,
        );
        const totalVnd = Number(os.total) || 0;

        const paidAmountVnd = Math.abs(Number(os.paidAmount || 0));
        const paidAmountCny = paidAmountVnd > 0 ? paidAmountVnd / rate : 0;

        let discountCny = 0;
        if (Number(os.discountRatio) > 0) {
          discountCny = (totalCny * Number(os.discountRatio)) / 100;
        } else if (os.discount) {
          discountCny = Math.abs(Number(os.discount)) / rate;
        }
        const supplierDebtCny = Math.max(
          0,
          totalCny - discountCny - paidAmountCny,
        );
        const supplierDebtVnd = Number(os.supplierDebt) || 0;

        const row = sheet.addRow({
          code: os.code,
          purchaseOrderCodes,
          contractNos,
          orderDate: fmtDateTime(os.orderDate),
          createdAt: fmtDateTime(os.createdAt),
          updatedAt: fmtDateTime(os.updatedAt),
          supplier: os.supplier?.name || '',
          supplierCode: os.supplier?.code || '',
          branch: os.branch?.name || '',
          orderBy: os.user?.name || '',
          creator: os.creator?.name || '',
          totalQty: Number(os.totalQty) || 0,
          productQty: Number(os.productQty) || 0,
          currency: isCny ? 'CNY' : 'VND',
          totalVnd,
          totalCny: isCny ? totalCny : '',
          discountVnd: Number(os.discount) || 0,
          supplierDebtVnd,
          supplierDebtCny: isCny ? supplierDebtCny : '',
          paidAmountVnd,
          paidAmountCny: isCny ? paidAmountCny : '',
          status: getOrderSupplierStatusLabel(os.status),
          description: os.description || '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm của PĐN = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildOrderSupplierWhere. Reuse toàn bộ
   * logic gom receivedQty + contractNos + vehicle info của getDetailItems để
   * kết quả xuất file khớp 1-1 với những gì UI đang hiển thị.
   */
  async exportOrderSuppliersDetail(
    query: OrderSupplierQueryDto,
    res: Response,
    supplierScope?: number | null,
  ): Promise<void> {
    const where = this.buildOrderSupplierWhere(query, supplierScope);
    const { search } = query;

    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const orderSuppliers = await this.prisma.orderSupplier.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        user: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              select: {
                kiotVietId: true,
                weight: true,
                weightUnit: true,
                parentName: true,
                middleName: true,
                childName: true,
                tradeMark: { select: { name: true } },
              },
            },
            productionStage: { select: { id: true, name: true } },
            factory: { select: { id: true, name: true } },
          },
        },
        purchaseOrders: {
          where: { isDraft: false, status: { not: 2 } },
          select: { items: { select: { productId: true, quantity: true } } },
        },
      },
    });

    // Gom DISTINCT Số HĐ + thông tin xe giống getDetailItems (xem comment ở
    // trên để hiểu vì sao cần lặp qua nhiều phiếu xe).
    const osIds = orderSuppliers.map((o) => o.id);
    const contractNosByKey = new Map<string, string[]>();
    const vehicleInfoByKey = new Map<
      string,
      {
        borderGateName: string | null;
        expectedArrivalDate: Date | null;
        actualArrivalDate: Date | null;
      }
    >();
    if (osIds.length > 0) {
      const shipItems = await this.prisma.vehicleShipmentItem.findMany({
        where: {
          orderSupplierId: { in: osIds },
          vehicleShipment: { status: { not: 3 } },
        },
        select: {
          orderSupplierId: true,
          productId: true,
          contractNo: true,
          vehicleShipment: {
            select: {
              expectedArrivalDate: true,
              actualArrivalDate: true,
              borderGate: { select: { name: true } },
            },
          },
        },
      });
      for (const si of shipItems) {
        const key = `${si.orderSupplierId}:${si.productId}`;
        if (si.contractNo) {
          const arr = contractNosByKey.get(key) ?? [];
          if (!arr.includes(si.contractNo)) arr.push(si.contractNo);
          contractNosByKey.set(key, arr);
        }
        if (!vehicleInfoByKey.has(key) && si.vehicleShipment) {
          vehicleInfoByKey.set(key, {
            borderGateName: si.vehicleShipment.borderGate?.name ?? null,
            expectedArrivalDate: si.vehicleShipment.expectedArrivalDate,
            actualArrivalDate: si.vehicleShipment.actualArrivalDate,
          });
        }
      }
    }

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết đặt hàng nhập');

    sheet.columns = [
      { header: 'Mã PĐN', key: 'orderSupplierCode', width: 18 },
      { header: 'Số HĐ', key: 'contractNos', width: 24 },
      { header: 'Ngày tạo', key: 'orderDate', width: 20 },
      { header: 'Nhà cung cấp', key: 'supplier', width: 24 },
      { header: 'Mã NCC', key: 'supplierCode', width: 14 },
      { header: 'Chi nhánh', key: 'branch', width: 18 },
      { header: 'Người tạo', key: 'creator', width: 18 },
      { header: 'Trạng thái', key: 'status', width: 18 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 32 },
      { header: 'Thương hiệu', key: 'tradeMark', width: 16 },
      { header: 'Nhóm hàng', key: 'productGroup', width: 22 },
      { header: 'SL đặt', key: 'orderedQty', width: 10 },
      { header: 'Đã nhập', key: 'receivedQty', width: 10 },
      { header: 'Còn lại', key: 'remainingQty', width: 10 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Giảm giá', key: 'discount', width: 14 },
      { header: 'Thành tiền', key: 'subTotal', width: 16 },
      { header: 'Đơn giá NM', key: 'factoryPrice', width: 14 },
      { header: 'Thành tiền NM', key: 'factorySubTotal', width: 16 },
      { header: 'Giai đoạn', key: 'productionStage', width: 18 },
      { header: 'Nhà máy', key: 'factory', width: 18 },
      { header: 'Cửa khẩu', key: 'borderGate', width: 16 },
      { header: 'Ngày dự kiến về', key: 'expectedArrival', width: 20 },
      { header: 'Ngày về thực tế', key: 'actualArrival', width: 20 },
      { header: 'Ghi chú dòng', key: 'itemDescription', width: 24 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    // Áp lọc dòng SP khớp `search` (giống getDetailItems): khi search khớp ở
    // cấp phiếu thì giữ toàn bộ dòng, ngược lại chỉ giữ dòng có mã/tên SP
    // khớp. Xuất theo cách này để tệp không phình khi user chỉ tìm 1 SP.
    const term = (search || '').trim().toLowerCase();

    let rowCount = 0;
    for (const os of orderSuppliers) {
      const receivedByProduct: Record<number, number> = {};
      for (const po of os.purchaseOrders) {
        for (const it of po.items) {
          receivedByProduct[it.productId] =
            (receivedByProduct[it.productId] || 0) + Number(it.quantity);
        }
      }
      const matchHeader =
        !!term &&
        ((os.code || '').toLowerCase().includes(term) ||
          (os.supplier?.name || '').toLowerCase().includes(term) ||
          (os.supplier?.code || '').toLowerCase().includes(term));

      for (const item of os.items) {
        const code = (item.productCode || '').toLowerCase();
        const name = (item.productName || '').toLowerCase();
        if (
          term &&
          !matchHeader &&
          !code.includes(term) &&
          !name.includes(term)
        )
          continue;

        const ordered = Number(item.quantity);
        const received = receivedByProduct[item.productId] || 0;
        const product = (item as any).product;
        const productGroup = [
          product?.parentName,
          product?.middleName,
          product?.childName,
        ]
          .filter(Boolean)
          .join(' / ');
        const veh = vehicleInfoByKey.get(`${os.id}:${item.productId}`);
        const contractNos =
          contractNosByKey.get(`${os.id}:${item.productId}`) ?? [];

        const row = sheet.addRow({
          orderSupplierCode: os.code,
          contractNos: contractNos.join(', '),
          orderDate: fmtDateTime(os.createdAt),
          supplier: os.supplier?.name || '',
          supplierCode: os.supplier?.code || '',
          branch: os.branch?.name || '',
          creator: os.creator?.name || '',
          status: getOrderSupplierStatusLabel(os.status),
          productCode: item.productCode || '',
          productName: item.productName || '',
          tradeMark: product?.tradeMark?.name || '',
          productGroup,
          orderedQty: ordered,
          receivedQty: received,
          remainingQty: Math.max(ordered - received, 0),
          price: Number(item.price) || 0,
          discount: Number(item.discount || 0),
          subTotal: Number(item.subTotal) || 0,
          factoryPrice:
            item.factoryPrice != null ? Number(item.factoryPrice) : '',
          factorySubTotal:
            item.factorySubTotal != null ? Number(item.factorySubTotal) : '',
          productionStage: (item as any).productionStage?.name || '',
          factory: (item as any).factory?.name || '',
          borderGate: veh?.borderGateName || '',
          expectedArrival: fmtDateTime(veh?.expectedArrivalDate),
          actualArrival: fmtDateTime(veh?.actualArrivalDate),
          itemDescription: item.description || '',
        });
        row.commit();
        rowCount += 1;
      }
    }

    // Nếu không có dòng nào, vẫn commit workbook để file tải về có header
    // (tránh trả về file rỗng gây nhầm lẫn cho user).
    if (rowCount === 0) {
      await workbook.commit();
      return;
    }

    await workbook.commit();
  }

  /**
   * Cập nhật inline giá nhà máy / thành tiền nhà máy của 1 dòng sản phẩm
   * (xác định bằng cặp orderSupplierId + productId) từ trang "Đặt hàng nhập
   * chi tiết". Hai trường độc lập nhau: sửa factoryPrice KHÔNG tự tính lại
   * factorySubTotal. Truyền null để xóa giá trị (cho phép trống).
   */
  async updateItemFactoryPrice(
    orderSupplierId: number,
    productId: number,
    dto: { factoryPrice?: number | null; factorySubTotal?: number | null },
    supplierScope?: number | null,
  ) {
    const item = await this.prisma.orderSupplierItem.findUnique({
      where: { orderSupplierId_productId: { orderSupplierId, productId } },
    });

    if (!item) {
      throw new NotFoundException(
        `Không tìm thấy dòng sản phẩm ${productId} trong phiếu ${orderSupplierId}`,
      );
    }

    await this.assertOrderSupplierInScope(orderSupplierId, supplierScope);

    const data: {
      factoryPrice?: number | null;
      factorySubTotal?: number | null;
    } = {};
    // Dùng !== undefined (không phải `in`) để tránh bị class-transformer
    // tự tạo key undefined cho field optional: như vậy field không gửi lên
    // sẽ KHÔNG bị ghi đè về null trong DB.
    if (dto.factoryPrice !== undefined)
      data.factoryPrice = dto.factoryPrice ?? null;
    if (dto.factorySubTotal !== undefined)
      data.factorySubTotal = dto.factorySubTotal ?? null;

    return this.prisma.orderSupplierItem.update({
      where: { orderSupplierId_productId: { orderSupplierId, productId } },
      data,
    });
  }

  /**
   * Cập nhật inline giai đoạn hiện tại / nhà máy của 1 dòng sản phẩm
   * (xác định bằng cặp orderSupplierId + productId) từ trang "Đặt hàng nhập
   * chi tiết". Hai trường độc lập nhau. Truyền null để bỏ chọn.
   */
  async updateItemStageFactory(
    orderSupplierId: number,
    productId: number,
    dto: { productionStageId?: number | null; factoryId?: number | null },
    supplierScope?: number | null,
  ) {
    const item = await this.prisma.orderSupplierItem.findUnique({
      where: { orderSupplierId_productId: { orderSupplierId, productId } },
    });

    if (!item) {
      throw new NotFoundException(
        `Không tìm thấy dòng sản phẩm ${productId} trong phiếu ${orderSupplierId}`,
      );
    }

    await this.assertOrderSupplierInScope(orderSupplierId, supplierScope);

    const data: {
      productionStageId?: number | null;
      factoryId?: number | null;
    } = {};
    if (dto.productionStageId !== undefined)
      data.productionStageId = dto.productionStageId ?? null;
    if (dto.factoryId !== undefined) data.factoryId = dto.factoryId ?? null;

    return this.prisma.orderSupplierItem.update({
      where: { orderSupplierId_productId: { orderSupplierId, productId } },
      data,
    });
  }

  /**
   * Đảm bảo phiếu đặt hàng nhập thuộc phạm vi NCC của user (nếu user là nhân
   * viên NCC). Ném ForbiddenException nếu phiếu thuộc NCC khác.
   */
  private async assertOrderSupplierInScope(
    orderSupplierId: number,
    supplierScope?: number | null,
  ) {
    if (supplierScope == null) return;
    const os = await this.prisma.orderSupplier.findUnique({
      where: { id: orderSupplierId },
      select: { supplierId: true },
    });
    if (!os || os.supplierId !== supplierScope) {
      throw new ForbiddenException(
        'Không có quyền thao tác trên dữ liệu của nhà cung cấp khác',
      );
    }
  }

  async findOne(id: number, supplierScope?: number | null) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: {
        supplier: {
          select: {
            id: true,
            code: true,
            name: true,
            contactNumber: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        expensesOthers: true,
        purchaseOrders: {
          include: {
            items: {
              select: {
                productId: true,
                quantity: true,
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
        payments: true,
        vehicleShipmentItems: {
          where: { vehicleShipment: { status: { not: 3 } } },
          select: {
            productId: true,
            quantity: true,
            vehicleShipmentId: true,
            postImportStatus: true,
            vehicleShipment: { select: { status: true } },
          },
        },
      },
    });

    if (!orderSupplier) {
      throw new NotFoundException('Order supplier not found');
    }

    // Scope NCC: chặn nhân viên NCC xem phiếu của nhà cung cấp khác.
    if (supplierScope != null && orderSupplier.supplierId !== supplierScope) {
      throw new ForbiddenException(
        'Không có quyền xem dữ liệu của nhà cung cấp khác',
      );
    }

    // ── Tính các mốc số lượng per sản phẩm ───────────────────────────────────
    // received: tổng SL đã nhập qua PN active (isDraft=false, status≠2)
    // shippedTotal: tổng SL ghép xe (mọi xe chưa hủy) — dùng cho cột "Ghép xe"
    // reserved: phần ghép xe đang GIỮ CHỖ (đối xứng getQuantityMap):
    //   • xe chưa nhập (status 0/1): giữ full SL ghép
    //   • xe đã nhập (status 2): chỉ giữ phần THIẾU = max(ghép − nhận của xe đó,0)
    //     khi postImportStatus ∈ {pending,kept}; 'returned' → 0
    // remaining (Còn lại) = max(ordered − received − reserved, 0)
    const receivedByProduct: Record<number, number> = {};
    const receivedByVehicleProduct = new Map<string, number>(); // `${vehId}:${pId}`
    for (const po of orderSupplier.purchaseOrders) {
      const active = !(po as any).isDraft && (po as any).status !== 2;
      if (!active) continue;
      const vehId = (po as any).vehicleShipmentId as number | null;
      for (const it of po.items) {
        receivedByProduct[it.productId] =
          (receivedByProduct[it.productId] || 0) + Number(it.quantity);
        if (vehId != null) {
          const vk = `${vehId}:${it.productId}`;
          receivedByVehicleProduct.set(
            vk,
            (receivedByVehicleProduct.get(vk) || 0) + Number(it.quantity),
          );
        }
      }
    }

    const shippedTotalByProduct: Record<number, number> = {};
    const reservedByProduct: Record<number, number> = {};
    for (const vi of orderSupplier.vehicleShipmentItems as any[]) {
      const shipQty = Number(vi.quantity);
      shippedTotalByProduct[vi.productId] =
        (shippedTotalByProduct[vi.productId] || 0) + shipQty;

      const vehStatus = vi.vehicleShipment?.status ?? 0;
      let reserved: number;
      if (vehStatus === 2) {
        if (vi.postImportStatus === 'returned') {
          reserved = 0;
        } else {
          const recv =
            receivedByVehicleProduct.get(
              `${vi.vehicleShipmentId}:${vi.productId}`,
            ) || 0;
          reserved = Math.max(shipQty - recv, 0);
        }
      } else {
        reserved = shipQty;
      }
      reservedByProduct[vi.productId] =
        (reservedByProduct[vi.productId] || 0) + reserved;
    }

    const itemsEnriched = (orderSupplier.items as any[]).map((item) => {
      const ordered = Number(item.quantity);
      const received = receivedByProduct[item.productId] || 0;
      const reserved = reservedByProduct[item.productId] || 0;
      return {
        ...item,
        receivedQty: received,
        shippedQty: shippedTotalByProduct[item.productId] || 0,
        reservedQty: reserved,
        remainingQty: Math.max(ordered - received - reserved, 0),
      };
    });

    return { ...orderSupplier, items: itemsEnriched };
  }

  async create(dto: CreateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      // Cho phép user tự điền mã (đối xứng `productions.service.ts:141`).
      // Trim + check duplicate; nếu trống/không hợp lệ thì auto-generate.
      const code = await this.resolveOrderSupplierCode(tx, dto.code);

      const itemsData = await Promise.all(
        dto.items.map(async (item) => {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });

          if (!product) {
            throw new NotFoundException(
              `Product with id ${item.productId} not found`,
            );
          }

          // Nếu client KHÔNG gửi price (user không có quyền xem giá vốn) thì
          // tự tìm: (1) giá NCC gần nhất theo supplierId, (2) giá vốn CN.
          // Không ép = 0 để đơn giá luôn đúng dù người tạo không được phép nhìn thấy giá.
          const price = await this.resolveItemPrice(
            tx,
            item.price,
            item.productId,
            dto.branchId,
            dto.supplierId,
          );

          const subTotal = (price - (item.discount || 0)) * item.quantity;

          const factoryPrice =
            item.factoryPrice != null ? item.factoryPrice : null;
          const factorySubTotal =
            item.factorySubTotal != null
              ? item.factorySubTotal
              : factoryPrice != null
                ? factoryPrice * item.quantity
                : null;

          return {
            productId: item.productId,
            productCode: product.code,
            productName: product.name,
            quantity: item.quantity,
            price,
            discount: item.discount || 0,
            subTotal,
            factoryPrice,
            factorySubTotal,
            description: item.description,
            orderQuantity: item.quantity,
          };
        }),
      );

      const total = itemsData.reduce(
        (sum, item) => sum + Number(item.subTotal),
        0,
      );
      const discount = dto.discount || 0;
      const discountAmount = dto.discountRatio
        ? (total * dto.discountRatio) / 100
        : discount;
      const subTotal = total - discountAmount;
      const totalQuantity = itemsData.reduce(
        (sum, item) => sum + Number(item.quantity),
        0,
      );

      const paidAmount = Number(dto.paymentAmount || 0);

      // Chuẩn hoá currency/exchangeRate. Mặc định VND + rate=1 nếu client
      // không gửi. Khi currency = VND ép rate = 1 (không cho tỉ giá khác 1
      // với đồng nội tệ). Chỉ hỗ trợ 2 mã: VND | CNY (theo use case hiện tại).
      const currency = (dto.currency || 'VND').toUpperCase();
      if (!['VND', 'CNY'].includes(currency)) {
        throw new BadRequestException(
          `currency không hợp lệ: ${currency}. Chỉ chấp nhận VND hoặc CNY.`,
        );
      }
      const exchangeRate =
        currency === 'VND' ? 1 : Number(dto.exchangeRate ?? 0) || 0;
      if (currency === 'CNY' && exchangeRate <= 0) {
        throw new BadRequestException(
          'Khi currency = CNY thì exchangeRate phải > 0',
        );
      }

      const orderSupplier = await tx.orderSupplier.create({
        data: {
          code,
          supplierId: dto.supplierId,
          branchId: dto.branchId,
          userId: dto.userId,
          description: dto.description,
          status: dto.status || 0,
          statusValue: getOrderSupplierStatusLabel(dto.status || 0),
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          total,
          subTotal,
          totalAmt: subTotal,
          totalQty: totalQuantity,
          totalQuantity,
          productQty: itemsData.length,
          paidAmount,
          supplierDebt: subTotal - paidAmount,
          toComplete: dto.toComplete || false,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : new Date(),
          currency,
          exchangeRate,
          createdBy: userId,
          items: {
            create: itemsData,
          },
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: true,
        },
      });

      if (dto.paymentAmount && dto.paymentAmount > 0) {
        // Đối xứng `purchase-orders.service.ts`: bắt buộc PDN phải có chi nhánh
        // khi tạo CashFlow để tránh fallback `?? 1` ghi sai chi nhánh tiền chi.
        if (!orderSupplier.branchId) {
          throw new NotFoundException(
            'Phiếu đặt hàng nhập chưa có chi nhánh. Vui lòng chọn chi nhánh trước khi thanh toán.',
          );
        }

        const paymentCode = await this.generatePaymentCode(tx);

        let cashFlowMethod = 'cash';
        if (dto.paymentMethod === 'transfer') {
          cashFlowMethod = 'transfer';
        } else if (dto.paymentMethod === 'card') {
          cashFlowMethod = 'card';
        }

        // Tạo CashFlow TRƯỚC để có id gán vào OrderSupplierPayment.cashFlowId.
        // Đối xứng pattern phía bán.
        const cashFlow = await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: orderSupplier.branchId,
            cashFlowGroupId: 9,
            isReceipt: false,
            amount: dto.paymentAmount,
            transDate: new Date(),
            method: cashFlowMethod,
            // Gắn tài khoản ngân hàng công ty khi chuyển khoản để đối chiếu
            // sao kê + lọc sổ quỹ theo tài khoản.
            accountId:
              dto.paymentMethod === 'transfer'
                ? (dto.paymentAccountId ?? null)
                : null,
            partnerType: 'S',
            partnerId: orderSupplier.supplierId,
            partnerName: orderSupplier.supplier?.name,
            contactNumber: orderSupplier.supplier?.contactNumber,
            address: orderSupplier.supplier?.address,
            description: `Chi tiền đặt hàng nhập ${orderSupplier.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            supplierDebtSnapshot: null,
          },
        });

        await tx.orderSupplierPayment.create({
          data: {
            code: paymentCode,
            orderSupplierId: orderSupplier.id,
            amount: dto.paymentAmount,
            paymentDate: new Date(),
            paymentMethod: dto.paymentMethod || 'cash',
            accountId:
              dto.paymentMethod === 'transfer'
                ? (dto.paymentAccountId ?? null)
                : null,
            // Tỉ giá quy đổi + thành tiền ngoại tệ (chỉ có khi NCC nước ngoài).
            // Snapshot riêng tại thời điểm thanh toán — không liên quan
            // OrderSupplier.exchangeRate (tỉ giá đặt hàng, chỉ tham khảo).
            exchangeRate: dto.paymentExchangeRate ?? null,
            foreignAmount: dto.paymentForeignAmount ?? null,
            description: `Trả tiền đặt hàng nhập ${orderSupplier.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
            cashFlowId: cashFlow.id,
          },
        });

        await this.updateSupplierDebt(dto.supplierId, tx);

        // Snapshot supplier debt sau recalc.
        const updatedSupplier = await tx.supplier.findUnique({
          where: { id: dto.supplierId },
          select: { debt: true },
        });
        await tx.cashFlow.update({
          where: { id: cashFlow.id },
          data: {
            supplierDebtSnapshot: updatedSupplier
              ? Number(updatedSupplier.debt)
              : null,
          },
        });
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'ORDER_SUPPLIER_CREATE',
        entityType: 'order_suppliers',
        entityId: orderSupplier.id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_CREATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_CREATE'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_CREATE', {
          orderSupplierCode: orderSupplier.code,
          supplierName: orderSupplier.supplier?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_SUPPLIER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });

      return orderSupplier;
    });
  }

  async update(id: number, dto: UpdateOrderSupplierDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.orderSupplier.findUnique({
        where: { id },
        include: {
          items: { include: { product: { select: { name: true } } } },
          supplier: true,
        },
      });

      if (!existing) {
        throw new NotFoundException(`OrderSupplier with id ${id} not found`);
      }

      let total = Number(existing.total);
      let discountAmount = Number(existing.discount);
      let subTotal = Number(existing.subTotal);
      let totalQuantity = Number(existing.totalQty);
      let currentPaidAmount = Number(existing.paidAmount);
      let productQty = Number(existing.productQty);

      // 1. Chỉ block xóa sản phẩm khỏi phiếu đặt khi sản phẩm đó đã được nhập kho
      // qua các phiếu nhập hàng liên kết (chưa hủy).
      if (dto.items) {
        const incomingProductIds = dto.items.map((item) => item.productId);
        const deletedProductIds = existing.items
          .map((item) => item.productId)
          .filter((prodId) => !incomingProductIds.includes(prodId));

        if (deletedProductIds.length > 0) {
          const hasReceived = await tx.purchaseOrderItem.findFirst({
            where: {
              productId: { in: deletedProductIds },
              purchaseOrder: {
                orderSupplierId: id,
                status: { not: 4 }, // Trừ các phiếu nhập đã bị hủy
              },
            },
            select: {
              productId: true,
              productName: true,
            },
          });

          if (hasReceived) {
            throw new BadRequestException(
              `Sản phẩm "${hasReceived.productName}" đã phát sinh phiếu nhập hàng liên quan. Không thể xóa sản phẩm này khỏi phiếu đặt.`,
            );
          }
        }
      }

      if (dto.items) {
        await tx.orderSupplierItem.deleteMany({
          where: { orderSupplierId: id },
        });

        const itemsData = await Promise.all(
          dto.items.map(async (item) => {
            const product = await tx.product.findUnique({
              where: { id: item.productId },
            });

            if (!product) {
              throw new NotFoundException(
                `Product with id ${item.productId} not found`,
              );
            }

            // Resolve giá nếu client không gửi (thiếu quyền xem giá vốn):
            // (1) giá NCC gần nhất, (2) giá vốn CN.
            const price = await this.resolveItemPrice(
              tx,
              item.price,
              item.productId,
              dto.branchId ?? existing.branchId ?? undefined,
              dto.supplierId ?? existing.supplierId ?? undefined,
            );

            const subTotal = (price - (item.discount || 0)) * item.quantity;

            const factoryPrice =
              item.factoryPrice != null ? item.factoryPrice : null;
            const factorySubTotal =
              item.factorySubTotal != null
                ? item.factorySubTotal
                : factoryPrice != null
                  ? factoryPrice * item.quantity
                  : null;

            return {
              orderSupplierId: id,
              productId: item.productId,
              productCode: product.code,
              productName: product.name,
              quantity: item.quantity,
              price,
              discount: item.discount || 0,
              subTotal,
              factoryPrice,
              factorySubTotal,
              description: item.description,
              orderQuantity: item.quantity,
            };
          }),
        );

        await tx.orderSupplierItem.createMany({
          data: itemsData,
        });

        total = itemsData.reduce((sum, item) => sum + Number(item.subTotal), 0);
        const discount = dto.discount || existing.discount;
        discountAmount = dto.discountRatio
          ? (total * dto.discountRatio) / 100
          : Number(discount);
        subTotal = total - discountAmount;
        totalQuantity = itemsData.reduce(
          (sum, item) => sum + Number(item.quantity),
          0,
        );
        productQty = itemsData.length;
      }

      // Cho phép đặt cọc / trả thêm cho NCC ngay khi cập nhật phiếu. Mỗi lần
      // submit form chỉ tạo MỚI một payment khi `dto.paymentAmount > 0` (FE
      // gửi undefined khi không thanh toán → không bao giờ nhân đôi khoản cũ).
      if (dto.paymentAmount && dto.paymentAmount > 0) {
        const payBranchId = dto.branchId ?? existing.branchId;
        const paySupplierId = dto.supplierId ?? existing.supplierId;

        // Bắt buộc PDN có chi nhánh trước khi tạo CashFlow (tránh fallback ?? 1
        // ghi sai chi nhánh tiền chi) — đối xứng nhánh `create`.
        if (!payBranchId) {
          throw new NotFoundException(
            'Phiếu đặt hàng nhập chưa có chi nhánh. Vui lòng chọn chi nhánh trước khi thanh toán.',
          );
        }

        const paymentCode = await this.generatePaymentCode(tx);

        let cashFlowMethod = 'cash';
        if (dto.paymentMethod === 'transfer') {
          cashFlowMethod = 'transfer';
        } else if (dto.paymentMethod === 'card') {
          cashFlowMethod = 'card';
        }

        const cashFlow = await tx.cashFlow.create({
          data: {
            code: paymentCode,
            branchId: payBranchId,
            cashFlowGroupId: 9,
            isReceipt: false,
            amount: dto.paymentAmount,
            transDate: new Date(),
            method: cashFlowMethod,
            // Gắn tài khoản ngân hàng công ty khi chuyển khoản để đối chiếu
            // sao kê + lọc sổ quỹ theo tài khoản.
            accountId:
              dto.paymentMethod === 'transfer'
                ? (dto.paymentAccountId ?? null)
                : null,
            partnerType: 'S',
            partnerId: paySupplierId,
            partnerName: existing.supplier?.name,
            contactNumber: existing.supplier?.contactNumber,
            address: existing.supplier?.address,
            description: `Chi tiền đặt hàng nhập ${existing.code}`,
            status: 0,
            statusValue: 'Đã thanh toán',
            createdBy: userId,
            usedForFinancialReporting: 1,
            supplierDebtSnapshot: null,
          },
        });

        await tx.orderSupplierPayment.create({
          data: {
            code: paymentCode,
            orderSupplierId: id,
            amount: dto.paymentAmount,
            paymentDate: new Date(),
            paymentMethod: dto.paymentMethod || 'cash',
            accountId:
              dto.paymentMethod === 'transfer'
                ? (dto.paymentAccountId ?? null)
                : null,
            // Tỉ giá quy đổi + thành tiền ngoại tệ (chỉ có khi NCC nước ngoài).
            // Snapshot riêng tại thời điểm thanh toán — không liên quan
            // OrderSupplier.exchangeRate (tỉ giá đặt hàng, chỉ tham khảo).
            exchangeRate: dto.paymentExchangeRate ?? null,
            foreignAmount: dto.paymentForeignAmount ?? null,
            description: `Trả tiền đặt hàng nhập ${existing.code}`,
            status: 1,
            statusValue: 'Đã thanh toán',
            cashFlowId: cashFlow.id,
          },
        });

        // Recalc Supplier.debt global (Formula B) + snapshot vào CashFlow.
        await this.updateSupplierDebt(paySupplierId, tx);
        const paidSupplier = await tx.supplier.findUnique({
          where: { id: paySupplierId },
          select: { debt: true },
        });
        await tx.cashFlow.update({
          where: { id: cashFlow.id },
          data: {
            supplierDebtSnapshot: paidSupplier
              ? Number(paidSupplier.debt)
              : null,
          },
        });
      }

      // Recompute paidAmount từ active payments (mirror Order.calculateTotals)
      // — single source of truth là OrderSupplierPayment ACTIVE.
      const activePayments = await tx.orderSupplierPayment.findMany({
        where: { orderSupplierId: id, status: { not: 2 } },
        select: { amount: true },
      });
      currentPaidAmount = activePayments.reduce(
        (sum: number, p: any) => sum + Number(p.amount),
        0,
      );

      // Cho phép user đổi mã PDN khi update — đối xứng `productions.service.ts`.
      // `dto.code === undefined`: giữ nguyên `existing.code`.
      // `dto.code` có giá trị: trim + check duplicate (loại trừ chính phiếu này).
      const nextCode =
        dto.code === undefined
          ? existing.code
          : await this.resolveOrderSupplierCode(tx, dto.code, id);

      // 2. Chỉ block thay đổi tiền tệ/tỉ giá khi có sự thay đổi thực tế so với DB
      // và đã phát sinh phiếu nhập hàng liên quan.
      let nextCurrency = existing.currency || 'VND';
      let nextExchangeRate: number | null =
        existing.exchangeRate != null ? Number(existing.exchangeRate) : 1;

      const incomingCurrency =
        dto.currency !== undefined ? dto.currency.toUpperCase() : undefined;
      const incomingExchangeRate =
        dto.exchangeRate !== undefined ? Number(dto.exchangeRate) : undefined;

      const isCurrencyChanged =
        incomingCurrency !== undefined && incomingCurrency !== nextCurrency;
      const isExchangeRateChanged =
        incomingExchangeRate !== undefined &&
        incomingExchangeRate !== nextExchangeRate;

      if (isCurrencyChanged || isExchangeRateChanged) {
        const hasPurchaseOrder = await tx.purchaseOrder.findFirst({
          where: { orderSupplierId: id },
          select: { id: true },
        });
        if (hasPurchaseOrder) {
          throw new BadRequestException(
            'Phiếu đặt hàng nhập này đã có phiếu nhập hàng liên quan. ' +
              'Không thể thay đổi tiền tệ/tỉ giá vì sẽ làm lệch dữ liệu các phiếu nhập đã phát sinh.',
          );
        }
        if (incomingCurrency !== undefined) {
          if (!['VND', 'CNY'].includes(incomingCurrency)) {
            throw new BadRequestException(
              `currency không hợp lệ: ${incomingCurrency}. Chỉ chấp nhận VND hoặc CNY.`,
            );
          }
          nextCurrency = incomingCurrency;
        }
        if (nextCurrency === 'VND') {
          nextExchangeRate = 1;
        } else if (incomingExchangeRate !== undefined) {
          if (!(incomingExchangeRate > 0)) {
            throw new BadRequestException(
              'Khi currency = CNY thì exchangeRate phải > 0',
            );
          }
          nextExchangeRate = incomingExchangeRate;
        }
      }

      const updatedOrderSupplier = await tx.orderSupplier.update({
        where: { id },
        data: {
          code: nextCode,
          supplierId: dto.supplierId ?? existing.supplierId,
          branchId: dto.branchId ?? existing.branchId,
          userId: dto.userId ?? existing.userId,
          description: dto.description ?? existing.description,
          status: dto.status ?? existing.status,
          discount: discountAmount,
          discountRatio: dto.discountRatio ?? existing.discountRatio,
          total,
          subTotal,
          totalAmt: subTotal,
          totalQty: totalQuantity,
          totalQuantity,
          productQty,
          paidAmount: currentPaidAmount,
          supplierDebt: subTotal - currentPaidAmount,
          orderDate: dto.orderDate
            ? new Date(dto.orderDate)
            : existing.orderDate,
          currency: nextCurrency,
          exchangeRate: nextExchangeRate,
        },
        include: {
          supplier: true,
          branch: true,
          user: true,
          creator: true,
          items: { include: { product: { select: { name: true } } } },
          payments: true,
        },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      // Build fieldChanges + itemChanges đối xứng `Order.update` phía bán
      // (orders.service.ts:476-513). Audit trail PDN giờ có đủ thông tin
      // "đổi gì" thay vì chỉ snapshot mới.
      const fieldChanges = buildChanges(
        'order_suppliers',
        {
          code: existing.code,
          statusValue: existing.statusValue,
          subTotal: Number(existing.subTotal),
          discount: Number(existing.discount || 0),
          discountRatio: Number(existing.discountRatio || 0),
          description: existing.description,
          supplierId: existing.supplierId,
          currency: existing.currency || 'VND',
          exchangeRate:
            existing.exchangeRate != null ? Number(existing.exchangeRate) : 1,
        },
        {
          code: updatedOrderSupplier.code,
          statusValue: updatedOrderSupplier.statusValue,
          subTotal: Number(updatedOrderSupplier.subTotal),
          discount: Number(updatedOrderSupplier.discount || 0),
          discountRatio: Number(updatedOrderSupplier.discountRatio || 0),
          description: updatedOrderSupplier.description,
          supplierId: updatedOrderSupplier.supplierId,
          currency: updatedOrderSupplier.currency || 'VND',
          exchangeRate:
            updatedOrderSupplier.exchangeRate != null
              ? Number(updatedOrderSupplier.exchangeRate)
              : 1,
        },
      );

      const itemChanges = buildItemChanges(
        existing.items.map((i: any) => ({
          productId: i.productId,
          productName: i.product?.name || i.productName,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
        updatedOrderSupplier.items.map((i: any) => ({
          productId: i.productId,
          productName: i.product?.name || i.productName,
          quantity: Number(i.quantity),
          price: Number(i.price),
          discount: Number(i.discount || 0),
        })),
      );

      const allChanges = [...fieldChanges, ...itemChanges];

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_UPDATE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: updatedOrderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_UPDATE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_UPDATE'),
        snapshot: this.buildOrderSupplierSnapshot(updatedOrderSupplier),
        changes: allChanges.length > 0 ? allChanges : null,
        message: renderAuditMessage('ORDER_SUPPLIER_UPDATE', {
          orderSupplierCode: updatedOrderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: updatedOrderSupplier.branchId || user?.branchId || undefined,
      });

      return updatedOrderSupplier;
    });
  }

  /**
   * Hủy mềm phiếu đặt hàng nhập (PDN). Mirror chính xác `OrdersService.cancelOrder`
   * của phía bán:
   *   - Block khi đã CANCELLED hoặc khi đã có PurchaseOrder con (active).
   *   - dto.cancelPayments=true: soft cancel mọi OrderSupplierPayment + CashFlow
   *     PCPDN match theo code, set paidAmount=0, supplierDebt=0.
   *   - dto.cancelPayments=false: vẫn cho hủy nhưng KHÔNG đụng payment — user phải
   *     xóa từng payment trước. Đối xứng pattern phía bán.
   *   - Recalc Supplier.debt qua Formula B sau cùng.
   */
  async cancelOrderSupplier(
    id: number,
    dto: CancelOrderSupplierDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id },
        include: {
          items: true,
          purchaseOrders: {
            where: { status: { not: 2 } },
            select: { id: true, code: true, isDraft: true },
          },
          payments: { where: { status: { not: 2 } } },
          supplier: {
            select: { id: true, code: true, name: true, debt: true },
          },
          creator: { select: { id: true, name: true } },
        },
      });

      if (!orderSupplier) {
        throw new NotFoundException('Không tìm thấy phiếu đặt hàng nhập');
      }

      // Status 4 = CANCELLED (đối xứng ORDER_STATUS.CANCELLED phía bán)
      if (orderSupplier.status === 4) {
        throw new BadRequestException(
          'Phiếu đặt hàng nhập đã được hủy trước đó',
        );
      }

      // Block khi còn PN active — đối xứng "Đơn hàng có hóa đơn" phía bán
      const hasActivePurchaseOrders =
        orderSupplier.purchaseOrders && orderSupplier.purchaseOrders.length > 0;
      if (hasActivePurchaseOrders) {
        throw new BadRequestException(
          'Phiếu đặt hàng nhập đã có phiếu nhập. Vui lòng hủy tất cả phiếu nhập trước khi hủy phiếu đặt hàng nhập',
        );
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });

      if (dto.cancelPayments && orderSupplier.payments.length > 0) {
        const paymentIds = orderSupplier.payments.map((p: any) => p.id);
        const paymentCodes = orderSupplier.payments
          .map((p: any) => p.code)
          .filter((c: any): c is string => !!c);
        const explicitCashFlowIds = orderSupplier.payments
          .map((p: any) => p.cashFlowId)
          .filter((id: any): id is number => typeof id === 'number');

        // Soft-cancel OrderSupplierPayment (giữ audit, không hard-delete)
        await tx.orderSupplierPayment.updateMany({
          where: { id: { in: paymentIds } },
          data: { status: 2, statusValue: 'Đã hủy' },
        });

        // Soft-cancel CashFlow PCPDN: ưu tiên match qua FK cashFlowId,
        // fallback `code` (đối xứng `invoice-payments.service.ts:191-208`).
        const orConditions: any[] = [];
        if (explicitCashFlowIds.length > 0) {
          orConditions.push({ id: { in: explicitCashFlowIds } });
        }
        if (paymentCodes.length > 0) {
          orConditions.push({ code: { in: paymentCodes } });
        }
        if (orConditions.length > 0) {
          await tx.cashFlow.updateMany({
            where: {
              OR: orConditions,
              partnerType: 'S',
              partnerId: orderSupplier.supplierId,
              status: { not: 2 },
            },
            data: { status: 2, statusValue: 'Đã hủy' },
          });
        }

        // Audit log từng payment (đối xứng phía bán log ORDER_PAYMENT_DELETE)
        for (const payment of orderSupplier.payments) {
          await this.auditLogsService.create({
            actionType: 'DELETE',
            actionCode: 'ORDER_SUPPLIER_PAYMENT_DELETE',
            entityType: 'order_supplier_payment',
            entityId: payment.id.toString(),
            entityCode: payment.code,
            category: getCategoryFromActionCode(
              'ORDER_SUPPLIER_PAYMENT_DELETE',
            ),
            severity: getSeverityFromActionCode(
              'ORDER_SUPPLIER_PAYMENT_DELETE',
            ),
            snapshot: {
              code: payment.code,
              amount: Number(payment.amount),
              paymentMethod: payment.paymentMethod,
              orderSupplier: {
                code: orderSupplier.code,
                supplier: orderSupplier.supplier,
              },
            },
            message: renderAuditMessage('ORDER_SUPPLIER_PAYMENT_DELETE', {
              paymentCode: payment.code,
              orderSupplierCode: orderSupplier.code,
            }),
            messageTemplate: 'ORDER_SUPPLIER_PAYMENT_DELETE',
            userId,
            userName: user?.name || 'System',
            branchId: orderSupplier.branchId || undefined,
          });
        }
      } else if (orderSupplier.payments.length > 0 && !dto.cancelPayments) {
        // Đối xứng pattern phía bán: nếu user không gửi cancelPayments=true mà
        // còn payment active, vẫn cho hủy nhưng payment giữ nguyên. Tuy nhiên
        // điều này dẫn tới supplierDebt không đồng bộ — block để user buộc
        // phải quyết định rõ.
        throw new BadRequestException(
          'Phiếu đặt hàng nhập có thanh toán. Hãy hủy thanh toán trước hoặc gửi cancelPayments=true để hủy luôn thanh toán',
        );
      }

      // Update PDN sang CANCELLED — đối xứng `Order.status=CANCELLED`
      await tx.orderSupplier.update({
        where: { id },
        data: {
          status: 4,
          statusValue: 'Đã hủy',
          ...(dto.cancelPayments && orderSupplier.payments.length > 0
            ? { paidAmount: 0, supplierDebt: 0 }
            : { supplierDebt: 0 }),
        },
      });

      // Recalc Supplier.debt qua Formula B (filter status≠2 tự loại records vừa hủy)
      await this.updateSupplierDebt(orderSupplier.supplierId, tx);

      // Audit ORDER_SUPPLIER_CANCEL
      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_CANCEL',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_CANCEL'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_CANCEL'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_CANCEL', {
          orderSupplierCode: orderSupplier.code,
          supplierName: orderSupplier.supplier?.name || 'N/A',
        }),
        messageTemplate: 'ORDER_SUPPLIER_CANCEL',
        userId,
        userName: user?.name || 'System',
        branchId: orderSupplier.branchId || undefined,
      });

      return { message: 'Hủy phiếu đặt hàng nhập thành công' };
    });
  }

  /**
   * Chốt hoàn thành PDN thủ công khi NCC không giao nốt phần còn thiếu
   * (vd 100 đặt / 99 nhập). Set status=3 + toComplete=true để
   * `updateOrderSupplierStatus` (phía PN) không hạ cấp về "Nhập một phần".
   */
  async completeOrderSupplier(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const orderSupplier = await tx.orderSupplier.findUnique({
        where: { id },
        include: { supplier: { select: { id: true, name: true } } },
      });
      if (!orderSupplier) {
        throw new NotFoundException('Không tìm thấy phiếu đặt hàng nhập');
      }
      if (orderSupplier.status === 4) {
        throw new BadRequestException('Phiếu đặt hàng nhập đã hủy');
      }
      if (orderSupplier.status === 3 && orderSupplier.toComplete) {
        throw new BadRequestException('Phiếu đặt hàng nhập đã hoàn thành');
      }

      const updated = await tx.orderSupplier.update({
        where: { id },
        data: { status: 3, statusValue: 'Hoàn thành', toComplete: true },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'ORDER_SUPPLIER_COMPLETE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_COMPLETE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_COMPLETE'),
        message: renderAuditMessage('ORDER_SUPPLIER_COMPLETE', {
          orderSupplierCode: orderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_COMPLETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });

      return updated;
    });
  }

  async remove(id: number, userId: number) {
    const orderSupplier = await this.prisma.orderSupplier.findUnique({
      where: { id },
      include: { branch: { select: { name: true } } }, // THÊM
    });

    if (!orderSupplier) {
      throw new NotFoundException(`OrderSupplier with id ${id} not found`);
    }

    await this.prisma.orderSupplier.delete({
      where: { id },
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'ORDER_SUPPLIER_DELETE',
        entityType: 'order_suppliers',
        entityId: id.toString(),
        entityCode: orderSupplier.code,
        category: getCategoryFromActionCode('ORDER_SUPPLIER_DELETE'),
        severity: getSeverityFromActionCode('ORDER_SUPPLIER_DELETE'),
        snapshot: this.buildOrderSupplierSnapshot(orderSupplier),
        message: renderAuditMessage('ORDER_SUPPLIER_DELETE', {
          orderSupplierCode: orderSupplier.code,
        }),
        messageTemplate: 'ORDER_SUPPLIER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: orderSupplier.branchId || user?.branchId || undefined,
      });
    }

    return { message: 'Xóa phiếu đặt hàng nhập thành công' };
  }

  /**
   * Tổng số lượng "Đặt NCC" cho từng productId.
   * Đặt NCC = số lượng CÒN LẠI cần nhập = sum(SL đặt − SL đã nhập) cho từng
   * sản phẩm, tính trên các phiếu OrderSupplier có status thuộc
   * { Đã xác nhận NCC (1), Nhập một phần (2) }.
   *
   * "Đã nhập" = tổng SL của sản phẩm đó trên các PurchaseOrder ACTIVE của phiếu
   * (không phải Phiếu tạm: isDraft=false, không bị hủy: status≠2) — đối xứng
   * `PurchaseOrdersService.createFromOrderSupplier` (receivedQuantities).
   *
   * Chỉ cộng phần còn lại > 0: sản phẩm đã nhập đủ trên 1 phiếu thì phiếu đó
   * không còn đóng góp vào "Đặt NCC" của sản phẩm (dù phiếu vẫn ở trạng thái
   * Nhập một phần vì sản phẩm khác chưa nhập xong).
   *
   * Nếu truyền branchId thì chỉ đếm phiếu thuộc chi nhánh đó.
   * Đối xứng `OrdersService.getPendingSummary` của phía bán.
   */
  /**
   * Giá nhập gần nhất của từng sản phẩm theo MỘT nhà cung cấp.
   * Lấy cột `price` (đơn giá nhập, KHÔNG trừ giảm giá) của dòng thuộc phiếu
   * đặt hàng nhập gần nhất (theo orderDate desc) của cặp supplier + product.
   * Loại trừ phiếu Đã hủy (status = 4).
   * Sản phẩm chưa có lịch sử với NCC này → fallback giá vốn hiện tại theo chi
   * nhánh (inventory.cost) nếu truyền branchId. Endpoint chạy ở BE nên KHÔNG bị
   * strip giá vốn theo quyền → dùng làm "giá nền" thống nhất cho mọi user.
   * Trả về { [productId]: number | null } — null nếu không có cả hai nguồn.
   */
  async getLatestSupplierPrices(
    supplierId: number,
    productIds: number[],
    branchId?: number,
  ): Promise<Record<number, number | null>> {
    const result: Record<number, number | null> = {};
    if (!supplierId || Number.isNaN(supplierId) || !productIds?.length) {
      return result;
    }
    productIds.forEach((id) => (result[id] = null));

    const items = await this.prisma.orderSupplierItem.findMany({
      where: {
        productId: { in: productIds },
        orderSupplier: { supplierId, status: { not: 4 } },
      },
      select: {
        productId: true,
        price: true,
        orderSupplier: { select: { orderDate: true } },
      },
      orderBy: [{ orderSupplier: { orderDate: 'desc' } }, { id: 'desc' }],
    });

    // Đã sort theo phiếu mới nhất trước → dòng đầu tiên gặp cho mỗi product là gần nhất.
    for (const it of items) {
      if (result[it.productId] == null) {
        result[it.productId] = Number(it.price);
      }
    }

    // Fallback giá vốn chi nhánh cho sản phẩm chưa từng nhập từ NCC này.
    if (branchId && !Number.isNaN(branchId)) {
      const missing = productIds.filter((id) => result[id] == null);
      if (missing.length > 0) {
        const invs = await this.prisma.inventory.findMany({
          where: { productId: { in: missing }, branchId },
          select: { productId: true, cost: true },
        });
        for (const inv of invs) {
          result[inv.productId] = Number(inv.cost);
        }
      }
    }

    return result;
  }

  async getConfirmedSummary(
    productIds: number[],
    branchId?: number,
    supplierScope?: number | null,
  ) {
    if (!productIds || productIds.length === 0) {
      return {} as Record<number, number>;
    }

    const orderSupplierWhere: any = {
      status: { in: [1, 2] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      // Lấy cả phiếu không gắn chi nhánh (branchId = null) — áp dụng cho mọi CN
      orderSupplierWhere.OR = [{ branchId }, { branchId: null }];
    }
    if (supplierScope != null) orderSupplierWhere.supplierId = supplierScope;

    const items = await this.prisma.orderSupplierItem.findMany({
      where: {
        productId: { in: productIds },
        orderSupplier: orderSupplierWhere,
      },
      select: {
        productId: true,
        quantity: true,
        orderSupplier: {
          select: {
            purchaseOrders: {
              where: { isDraft: false, status: { not: 2 } },
              select: {
                items: {
                  where: { productId: { in: productIds } },
                  select: { productId: true, quantity: true },
                },
              },
            },
          },
        },
      },
    });

    const result: Record<number, number> = {};
    for (const id of productIds) result[id] = 0;

    for (const item of items) {
      // SL đã nhập của riêng sản phẩm này trong phiếu (qua các PN active).
      let received = 0;
      for (const po of item.orderSupplier?.purchaseOrders || []) {
        for (const poItem of po.items) {
          if (poItem.productId === item.productId) {
            received += Number(poItem.quantity);
          }
        }
      }
      const remaining = Number(item.quantity) - received;
      if (remaining > 0) {
        result[item.productId] += remaining;
      }
    }
    return result;
  }

  /**
   * Lấy danh sách phiếu đặt hàng nhập (OrderSupplier) có chứa productId
   * đang ở trạng thái Đã xác nhận NCC (1) hoặc Nhập một phần (2).
   * Nếu truyền branchId thì lọc theo chi nhánh, không truyền thì lấy mọi chi nhánh.
   * Trả về thông tin tối thiểu cho modal: mã phiếu, ngày tạo, nhà cung cấp,
   * người tạo, tổng tiền, trạng thái, số lượng CÒN LẠI cần nhập của sản phẩm.
   *
   * `quantity` trả về = SL đặt − SL đã nhập (qua các PN active). Phiếu đã nhập
   * đủ sản phẩm này (còn lại ≤ 0) bị ẩn — khớp với cách tính `getConfirmedSummary`
   * và `createFromOrderSupplier`.
   *
   * Đối xứng `OrdersService.getPendingByProduct` của phía bán.
   */
  async getConfirmedByProduct(
    productId: number,
    branchId?: number,
    supplierScope?: number | null,
  ) {
    if (!productId || Number.isNaN(productId)) return [];

    const orderSupplierWhere: any = {
      status: { in: [1, 2] },
    };
    if (branchId && !Number.isNaN(branchId)) {
      // Lấy cả phiếu không gắn chi nhánh (branchId = null) — áp dụng cho mọi CN
      orderSupplierWhere.OR = [{ branchId }, { branchId: null }];
    }
    if (supplierScope != null) orderSupplierWhere.supplierId = supplierScope;

    const items = await this.prisma.orderSupplierItem.findMany({
      where: {
        productId,
        orderSupplier: orderSupplierWhere,
      },
      select: {
        quantity: true,
        orderSupplier: {
          select: {
            id: true,
            code: true,
            orderDate: true,
            createdAt: true,
            total: true,
            status: true,
            statusValue: true,
            supplier: { select: { id: true, code: true, name: true } },
            creator: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            purchaseOrders: {
              where: { isDraft: false, status: { not: 2 } },
              select: {
                items: {
                  where: { productId },
                  select: { quantity: true },
                },
              },
            },
          },
        },
      },
      orderBy: { orderSupplier: { createdAt: 'desc' } },
    });

    // Schema có @@unique([orderSupplierId, productId]) → thực tế 1 dòng/phiếu,
    // nhưng vẫn gộp theo orderSupplierId cho an toàn.
    const map = new Map<
      number,
      {
        orderSupplierId: number;
        code: string;
        createdAt: Date;
        orderDate: Date;
        total: number;
        status: number;
        statusValue: string;
        supplier: { id: number; code: string | null; name: string } | null;
        creator: { id: number; name: string | null } | null;
        branch: { id: number; name: string } | null;
        quantity: number;
      }
    >();

    for (const it of items) {
      const o = it.orderSupplier;
      // SL đã nhập của sản phẩm này trong phiếu (qua các PN active).
      const received = (o.purchaseOrders || []).reduce(
        (sum, po) =>
          sum + po.items.reduce((s, poItem) => s + Number(poItem.quantity), 0),
        0,
      );
      const remaining = Number(it.quantity) - received;
      const existing = map.get(o.id);
      if (existing) {
        existing.quantity += remaining;
      } else {
        map.set(o.id, {
          orderSupplierId: o.id,
          code: o.code,
          createdAt: o.createdAt,
          orderDate: o.orderDate,
          total: Number(o.total),
          status: o.status,
          // Luôn map từ status (number) → label tiếng Việt; không dùng
          // statusValue thô vì DB lưu không nhất quán.
          statusValue: getOrderSupplierStatusLabel(o.status),
          supplier: o.supplier,
          creator: o.creator,
          branch: o.branch,
          quantity: remaining,
        });
      }
    }

    // Ẩn phiếu đã nhập đủ sản phẩm này (còn lại ≤ 0).
    return Array.from(map.values())
      .filter((row) => row.quantity > 0)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Resolve mã PDN cho create/update:
   *   - Có `userCode` (sau trim, khác rỗng): kiểm duplicate trên
   *     `OrderSupplier.code`. `excludeId` để bỏ qua chính phiếu đang update.
   *   - Không có / rỗng: auto-generate qua `generateSafeOrderSupplierCode`.
   *
   * Dùng chung cho cả `create` và `update` để logic nhập mã thủ công đối xứng,
   * tránh fail im lặng khi user gửi mã trùng.
   */
  private async resolveOrderSupplierCode(
    tx: any,
    userCode?: string,
    excludeId?: number,
  ): Promise<string> {
    const trimmed = (userCode || '').trim();
    if (!trimmed) {
      return this.generateSafeOrderSupplierCode(tx);
    }

    const duplicate = await tx.orderSupplier.findFirst({
      where: {
        code: trimmed,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new BadRequestException(
        `Mã phiếu đặt hàng nhập "${trimmed}" đã tồn tại. Vui lòng nhập mã khác hoặc để trống để hệ thống tự sinh.`,
      );
    }

    return trimmed;
  }

  private async generateSafeOrderSupplierCode(tx?: any): Promise<string> {
    const prefix = 'PDN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allOrderSuppliers = await tx.orderSupplier.findMany({
        where: {
          code: { startsWith: prefix },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allOrderSuppliers
        .map((sup: any) => sup.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.orderSupplier.findFirst({ where: { code } });

      if (!exists) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã phiếu đặt hàng nhập duy nhất');
  }

  private async generatePaymentCode(tx: any): Promise<string> {
    const prefix = 'PCPDN';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allPayments = await tx.orderSupplierPayment.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
      });

      const validCodes = allPayments
        .map((p: any) => p.code)
        .filter((code: string) => regex.test(code))
        .sort((a: string, b: string) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const existsInPayment = await tx.orderSupplierPayment.findFirst({
        where: { code },
      });

      const existsInCashFlow = await tx.cashFlow.findFirst({
        where: { code },
      });

      if (!existsInPayment && !existsInCashFlow) return code;
      attempts++;
    }

    throw new Error('Không thể tạo mã thanh toán duy nhất');
  }

  private async updateSupplierDebt(supplierId: number, tx: any) {
    await recalcSupplierDebt(tx, supplierId);
  }

  /**
   * Resolve đơn giá nhập cho 1 dòng item.
   * - Nếu client gửi `price` (user có quyền xem giá vốn) → dùng nguyên giá đó.
   * - Nếu KHÔNG gửi (user bị ẩn giá vốn nên FE không có dữ liệu) → tự lấy giá
   *   vốn hiện tại của sản phẩm theo chi nhánh từ inventory. KHÔNG ép = 0 để
   *   đơn giá luôn đúng dù người tạo không được phép nhìn thấy giá.
   */
  private async resolveItemPrice(
    tx: any,
    price: number | undefined | null,
    productId: number,
    branchId?: number | null,
    supplierId?: number | null,
  ): Promise<number> {
    if (price !== undefined && price !== null && !Number.isNaN(Number(price))) {
      return Number(price);
    }
    // Giá nhập gần nhất theo NCC (loại phiếu Đã hủy). Áp dụng cho cả user không
    // có quyền xem giá vốn (FE không gửi price) → nghiệp vụ đồng nhất mọi user.
    if (supplierId) {
      const latest = await tx.orderSupplierItem.findFirst({
        where: {
          productId,
          orderSupplier: { supplierId, status: { not: 4 } },
        },
        select: { price: true },
        orderBy: [{ orderSupplier: { orderDate: 'desc' } }, { id: 'desc' }],
      });
      if (latest) return Number(latest.price);
    }
    if (branchId) {
      const inventory = await tx.inventory.findUnique({
        where: { productId_branchId: { productId, branchId } },
        select: { cost: true },
      });
      if (inventory) return Number(inventory.cost);
    }
    return 0;
  }

  /**
   * Recompute cached fields trên OrderSupplier từ source of truth (items +
   * active payments). Mirror chính xác `OrdersService.calculateTotals` của
   * phía bán nhưng đối xứng:
   *   - KH: paymentStatus 'Draft'/'partial'/'paid' từ paidAmount vs grandTotal
   *   - NCC: dùng cùng logic, ghi vào `OrderSupplier` (paidAmount/supplierDebt)
   *
   * Phía bán có field `Order.paymentStatus` riêng. Phía mua không có field
   * tương đương trong schema OrderSupplier — bỏ qua. Cache còn lại đầy đủ.
   */
  private async calculateTotals(orderSupplierId: number, tx: any) {
    const items = await tx.orderSupplierItem.findMany({
      where: { orderSupplierId },
    });
    const payments = await tx.orderSupplierPayment.findMany({
      where: { orderSupplierId, status: { not: 2 } },
    });

    const total = items.reduce(
      (sum: number, item: any) => sum + Number(item.subTotal),
      0,
    );

    const orderSupplier = await tx.orderSupplier.findUnique({
      where: { id: orderSupplierId },
    });
    if (!orderSupplier) return;

    const discountAmount = Number(orderSupplier.discount) || 0;
    const discountFromRatio =
      (total * (Number(orderSupplier.discountRatio) || 0)) / 100;
    const subTotal = total - discountAmount - discountFromRatio;

    const paidAmount = payments.reduce(
      (sum: number, p: any) => sum + Number(p.amount),
      0,
    );
    const supplierDebt = subTotal - paidAmount;

    const totalQuantity = items.reduce(
      (sum: number, item: any) => sum + Number(item.quantity),
      0,
    );

    await tx.orderSupplier.update({
      where: { id: orderSupplierId },
      data: {
        total,
        subTotal,
        totalAmt: subTotal,
        totalQty: totalQuantity,
        totalQuantity,
        productQty: items.length,
        paidAmount,
        supplierDebt,
      },
    });
  }

  private buildOrderSupplierSnapshot(os: any) {
    return {
      code: os.code,
      supplierId: os.supplierId,
      supplierName: os.supplier?.name,
      supplierDebt: os.supplierDebt,
      branchId: os.branchId,
      branchName: os.branch?.name,
      status: os.status,
      statusValue: os.statusValue,
      total: Number(os.total || 0),
      discount: Number(os.discount || 0),
      paidAmount: Number(os.paidAmount || 0),
      items: (os.items || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        price: Number(item.price),
      })),
    };
  }
}
