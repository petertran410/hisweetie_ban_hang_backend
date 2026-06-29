import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import {
  CreateVehicleShipmentDto,
  UpdateVehicleShipmentDto,
  VehicleShipmentQueryDto,
  CreatePurchaseOrdersFromVehicleDto,
} from './dto';

/**
 * Trạng thái phiếu ghép xe (VehicleShipment):
 *   0 DRAFT      - Phiếu tạm
 *   1 CONFIRMED  - Đã xác nhận giao (xe đang chạy)
 *   2 RECEIVED   - Đã nhập (đã sinh phiếu nhập)
 *   3 CANCELLED  - Đã hủy
 */
function getVehicleShipmentStatusLabel(status: number): string {
  switch (status) {
    case 0:
      return 'Phiếu tạm';
    case 1:
      return 'Đã xác nhận giao';
    case 2:
      return 'Đã nhập';
    case 3:
      return 'Đã hủy';
    default:
      return 'Không xác định';
  }
}

@Injectable()
export class VehicleShipmentsService {
  constructor(
    private prisma: PrismaService,
    private purchaseOrdersService: PurchaseOrdersService,
    private auditLogsService: AuditLogsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Tính map số lượng cho từng (orderSupplierId, productId) của một tập PDN:
   *   - ordered  : SL đặt (OrderSupplierItem.quantity)
   *   - received : SL đã nhập qua PN active (isDraft=false, status≠2)
   *   - shipped  : SL đang bị GIỮ CHỖ bởi ghép xe (reserved), KHÔNG trùng với
   *                phần đã nhập. Cụ thể với mỗi dòng ghép xe (xe status≠3):
   *                  • Xe chưa nhập (status 0/1): giữ full `quantity` ghép.
   *                  • Xe đã nhập (status 2): phần thực nhận đã nằm trong
   *                    `received`. Chỉ giữ thêm phần THIẾU = max(ghép − nhận
   *                    của chính xe đó, 0) khi postImportStatus ∈ {pending,kept}.
   *                    Nếu 'returned' → nhả phần thiếu (giữ 0). Nhập dư (nhận >
   *                    ghép) → giữ 0, phần dư tự trừ qua `received`.
   *
   * "Còn để ghép" = ordered − received − shipped.
   * Khi `excludeVehicleId` được truyền, bỏ phần giữ của chính xe đó (để khi sửa
   * xe không tự trừ chính mình).
   */
  private async getQuantityMap(
    orderSupplierIds: number[],
    excludeVehicleId?: number,
  ): Promise<
    Map<string, { ordered: number; received: number; shipped: number }>
  > {
    const map = new Map<
      string,
      { ordered: number; received: number; shipped: number }
    >();
    if (orderSupplierIds.length === 0) return map;

    const key = (osId: number, pId: number) => `${osId}:${pId}`;

    // ordered + received (PN active của từng PDN)
    const orderSuppliers = await this.prisma.orderSupplier.findMany({
      where: { id: { in: orderSupplierIds } },
      select: {
        id: true,
        items: { select: { productId: true, quantity: true } },
        purchaseOrders: {
          where: { isDraft: false, status: { not: 2 } },
          select: { items: { select: { productId: true, quantity: true } } },
        },
      },
    });

    for (const os of orderSuppliers) {
      const receivedByProduct: Record<number, number> = {};
      for (const po of os.purchaseOrders) {
        for (const it of po.items) {
          receivedByProduct[it.productId] =
            (receivedByProduct[it.productId] || 0) + Number(it.quantity);
        }
      }
      for (const item of os.items) {
        map.set(key(os.id, item.productId), {
          ordered: Number(item.quantity),
          received: receivedByProduct[item.productId] || 0,
          shipped: 0,
        });
      }
    }

    // Các dòng ghép xe (xe chưa hủy, loại trừ xe đang sửa) kèm trạng thái xe.
    const shipmentItems = await this.prisma.vehicleShipmentItem.findMany({
      where: {
        orderSupplierId: { in: orderSupplierIds },
        vehicleShipment: {
          status: { not: 3 },
          ...(excludeVehicleId ? { id: { not: excludeVehicleId } } : {}),
        },
      },
      select: {
        orderSupplierId: true,
        productId: true,
        quantity: true,
        postImportStatus: true,
        vehicleShipmentId: true,
        vehicleShipment: { select: { status: true } },
      },
    });

    // Thực nhận theo từng (vehicleShipmentId, orderSupplierId, productId) —
    // lấy từ các PN active gắn với xe đó.
    const vehicleIds = [
      ...new Set(shipmentItems.map((si) => si.vehicleShipmentId)),
    ];
    const receivedByVehicle = new Map<string, number>(); // `${vehId}:${os}:${pId}`
    if (vehicleIds.length > 0) {
      const vehiclePOs = await this.prisma.purchaseOrder.findMany({
        where: {
          vehicleShipmentId: { in: vehicleIds },
          isDraft: false,
          status: { not: 2 },
        },
        select: {
          vehicleShipmentId: true,
          orderSupplierId: true,
          items: { select: { productId: true, quantity: true } },
        },
      });
      for (const po of vehiclePOs) {
        if (po.vehicleShipmentId == null || po.orderSupplierId == null)
          continue;
        for (const it of po.items) {
          const vk = `${po.vehicleShipmentId}:${po.orderSupplierId}:${it.productId}`;
          receivedByVehicle.set(
            vk,
            (receivedByVehicle.get(vk) || 0) + Number(it.quantity),
          );
        }
      }
    }

    for (const si of shipmentItems) {
      const shipQty = Number(si.quantity);
      const vehStatus = si.vehicleShipment?.status ?? 0;

      let reserved: number;
      if (vehStatus === 2) {
        // Xe đã nhập: phần nhận đã ở `received`. Giữ thêm phần thiếu nếu chưa
        // 'returned'. Nhập dư → max(...,0) = 0.
        if (si.postImportStatus === 'returned') {
          reserved = 0;
        } else {
          const vk = `${si.vehicleShipmentId}:${si.orderSupplierId}:${si.productId}`;
          const recvThisVehicle = receivedByVehicle.get(vk) || 0;
          reserved = Math.max(shipQty - recvThisVehicle, 0);
        }
      } else {
        // Xe chưa nhập (0/1): giữ full SL ghép.
        reserved = shipQty;
      }

      const k = key(si.orderSupplierId, si.productId);
      const entry = map.get(k);
      if (entry) {
        entry.shipped += reserved;
      } else {
        map.set(k, { ordered: 0, received: 0, shipped: reserved });
      }
    }

    return map;
  }

  private async resolveCode(
    tx: any,
    userCode?: string,
    excludeId?: number,
  ): Promise<string> {
    const trimmed = (userCode || '').trim();
    if (!trimmed) {
      return this.generateCode(tx);
    }
    const duplicate = await tx.vehicleShipment.findFirst({
      where: {
        code: trimmed,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `Mã phiếu ghép xe "${trimmed}" đã tồn tại. Vui lòng nhập mã khác hoặc để trống để hệ thống tự sinh.`,
      );
    }
    return trimmed;
  }

  private async generateCode(tx: any): Promise<string> {
    const prefix = 'XE';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    while (attempts < 10) {
      const rows = await tx.vehicleShipment.findMany({
        where: { code: { startsWith: prefix } },
        select: { code: true },
        orderBy: { id: 'desc' },
      });
      const validCodes = rows
        .map((r: any) => r.code)
        .filter((c: string) => regex.test(c))
        .sort((a: string, b: string) => {
          return (
            parseInt(b.replace(prefix, '')) - parseInt(a.replace(prefix, ''))
          );
        });
      let next = 1;
      if (validCodes.length > 0) {
        const m = validCodes[0].match(/\d+$/);
        if (m) next = parseInt(m[0]) + 1;
      }
      const code = `${prefix}${String(next).padStart(6, '0')}`;
      const exists = await tx.vehicleShipment.findFirst({ where: { code } });
      if (!exists) return code;
      attempts++;
    }
    throw new Error('Không thể tạo mã phiếu ghép xe duy nhất');
  }

  private async buildItemsData(
    tx: any,
    items: {
    orderSupplierId: number;
    productId: number;
    quantity: number;
    contractNo?: string;
  }[],
  excludeVehicleId?: number,
) {
    if (!items || items.length === 0) {
      throw new BadRequestException(
        'Phiếu ghép xe phải có ít nhất 1 dòng hàng',
      );
    }

    const result: any[] = [];
    for (const item of items) {
      if (item.quantity <= 0) {
        throw new BadRequestException('Số lượng ghép phải lớn hơn 0');
      }

      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: { code: true, name: true },
      });
      if (!product) {
        throw new NotFoundException(
          `Không tìm thấy sản phẩm id ${item.productId}`,
        );
      }

      // Bỏ chặn cho phép ghép vượt số lượng có thể ghép (over-pick).
      // Lý do: thực tế vận chuyển có thể giao dư/thiếu so với PĐN, hoặc NV
      // muốn chủ động điều chỉnh dòng hàng cho khớp thực tế. Check
      // `quantity > 0` ở trên đã đủ chặn nhập 0/âm. Tồn kho khi sinh phiếu
      // nhập từ xe (`createPurchaseOrders` → `updateInventory`) sẽ cộng đúng
      // theo `receivedQuantity` user nhập, không cap về ordered.

      result.push({
        orderSupplierId: item.orderSupplierId,
        productId: item.productId,
        productCode: product.code,
        productName: product.name,
        quantity: item.quantity,
        // Số HĐ per-item. Trim + null khi rỗng để DB nhận đúng giá trị
        // (Prisma coi '' và null khác nhau — tránh conflict với unique
        // `(vehicleShipmentId, orderSupplierId, productId, contractNo)`
        // vì PostgreSQL coi NULL không bằng nhau trong unique).
        contractNo: item.contractNo?.trim() || null,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async findAll(query: VehicleShipmentQueryDto, supplierScope?: number | null) {
    const {
      pageSize = 15,
      currentItem = 0,
      search,
      contractNo,
      branchId,
      branchIds,
      borderGateId,
      createdById,
      status,
      createdDateFrom,
      createdDateTo,
    } = query;

    const where: any = {};
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { vehicleInfo: { contains: search, mode: 'insensitive' } },
        {
          items: {
            some: {
              OR: [
                { productCode: { contains: search, mode: 'insensitive' } },
                { productName: { contains: search, mode: 'insensitive' } },
                { contractNo: { contains: search, mode: 'insensitive' } },
                {
                  orderSupplier: {
                    code: { contains: search, mode: 'insensitive' },
                  },
                },
              ],
            },
          },
        },
      ];
    }
    if (contractNo) {
      where.AND = [
        ...(where.AND || []),
        {
          items: {
            some: { contractNo: { equals: contractNo } },
          },
        },
      ];
    }
    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    } else if (branchId) {
      where.branchId = branchId;
    }
    if (borderGateId) where.borderGateId = borderGateId;
    if (createdById) where.createdBy = createdById;
    if (status !== undefined) where.status = status;
    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) where.createdAt.gte = new Date(createdDateFrom);
      if (createdDateTo) where.createdAt.lte = new Date(createdDateTo);
    }

    // Scope NCC: chỉ trả phiếu ghép xe có chứa hàng của NCC này.
    if (supplierScope != null) {
      where.AND = [
        ...(where.AND || []),
        {
          items: {
            some: { orderSupplier: { supplierId: supplierScope } },
          },
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.vehicleShipment.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: {
          branch: { select: { id: true, name: true } },
          borderGate: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          items: {
            include: {
              orderSupplier: {
                select: {
                  id: true,
                  code: true,
                  supplierId: true,
                  supplier: { select: { id: true, code: true, name: true } },
                },
              },
            },
          },
          purchaseOrders: { select: { id: true, code: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.vehicleShipment.count({ where }),
    ]);

    // Ẩn dòng item của NCC khác (giữ nguyên các số tổng toàn phiếu).
    if (supplierScope != null) {
      for (const vs of data as any[]) {
        vs.items = (vs.items || []).filter(
          (it: any) => it.orderSupplier?.supplierId === supplierScope,
        );
      }
    }

    return { data, total, pageSize, currentItem };
  }

  async getContractNos(supplierScope?: number | null) {
    const rows = await this.prisma.vehicleShipmentItem.findMany({
      where: {
        contractNo: { not: null },
        vehicleShipment: { status: { not: 3 } },
        ...(supplierScope != null
          ? { orderSupplier: { supplierId: supplierScope } }
          : {}),
      },
      select: { contractNo: true },
      distinct: ['contractNo'],
      orderBy: { contractNo: 'asc' },
    });

    return rows
      .map((r) => r.contractNo?.trim())
      .filter((v): v is string => !!v);
  }

  async findOne(id: number, supplierScope?: number | null) {
    const shipment = await this.prisma.vehicleShipment.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        borderGate: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
                weight: true,
                weightUnit: true,
              },
            },
            orderSupplier: {
              select: {
                id: true,
                code: true,
                supplierId: true,
                supplier: { select: { id: true, code: true, name: true } },
              },
            },
          },
        },
        purchaseOrders: {
          select: { id: true, code: true, status: true, statusValue: true },
        },
      },
    });
    if (!shipment) {
      throw new NotFoundException('Không tìm thấy phiếu ghép xe');
    }

    // Scope NCC: chặn nếu phiếu không chứa hàng của NCC này.
    if (supplierScope != null) {
      const hasOwnItem = (shipment.items || []).some(
        (it: any) => it.orderSupplier?.supplierId === supplierScope,
      );
      if (!hasOwnItem) {
        throw new ForbiddenException(
          'Không có quyền xem dữ liệu của nhà cung cấp khác',
        );
      }
    }

    // Thực nhận theo từng (orderSupplierId, productId) qua các PN active gắn
    // với chính xe này → tính chênh lệch để phục vụ "xử lý sau nhập".
    const vehiclePOs = await this.prisma.purchaseOrder.findMany({
      where: {
        vehicleShipmentId: id,
        isDraft: false,
        status: { not: 2 },
      },
      select: {
        orderSupplierId: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    const receivedMap = new Map<string, number>(); // `${os}:${pId}`
    for (const po of vehiclePOs) {
      if (po.orderSupplierId == null) continue;
      for (const it of po.items) {
        const k = `${po.orderSupplierId}:${it.productId}`;
        receivedMap.set(k, (receivedMap.get(k) || 0) + Number(it.quantity));
      }
    }

    let totalWeightKg = 0;
    const itemsWithDiff = (shipment.items || []).map((it: any) => {
      const shippedQty = Number(it.quantity);
      const received =
        receivedMap.get(`${it.orderSupplierId}:${it.productId}`) || 0;
      // Quy đổi trọng lượng đơn vị về kg (weightUnit có thể là 'g' hoặc 'kg').
      const unitWeight = it.product?.weight ? Number(it.product.weight) : 0;
      const unitKg =
        (it.product?.weightUnit || 'kg').toLowerCase() === 'g'
          ? unitWeight / 1000
          : unitWeight;
      const lineWeightKg = unitKg * shippedQty;
      totalWeightKg += lineWeightKg;
      return {
        ...it,
        shipped: shippedQty,
        received,
        diff: shippedQty - received, // >0 thiếu, <0 dư
        unitWeight,
        weightUnit: it.product?.weightUnit || 'kg',
        lineWeightKg,
      };
    });

    // Ẩn dòng của NCC khác (tổng totalWeightKg vẫn tính trên toàn phiếu).
    const visibleItems =
      supplierScope != null
        ? itemsWithDiff.filter(
            (it: any) => it.orderSupplier?.supplierId === supplierScope,
          )
        : itemsWithDiff;

    return { ...shipment, items: visibleItems, totalWeightKg };
  }

  /**
   * Danh sách các dòng (PDN + SP) còn có thể ghép xe (remaining > 0).
   * Dùng cho form tạo/sửa xe để người dùng chọn hàng.
   */
  async getAvailableItems(branchId?: number, supplierScope?: number | null) {
    // Lấy PDN ở trạng thái Đã xác nhận NCC (1) hoặc Nhập một phần (2).
    const orderSupplierWhere: any = { status: { in: [1, 2] } };
    if (branchId && !Number.isNaN(branchId)) {
      orderSupplierWhere.OR = [{ branchId }, { branchId: null }];
    }
    // Scope NCC: chỉ lấy PDN của nhà cung cấp này.
    if (supplierScope != null) orderSupplierWhere.supplierId = supplierScope;

    const orderSuppliers = await this.prisma.orderSupplier.findMany({
      where: orderSupplierWhere,
      select: {
        id: true,
        code: true,
        orderDate: true,
        branchId: true,
        status: true,
        statusValue: true,
        supplier: { select: { id: true, code: true, name: true } },
        items: {
          select: {
            productId: true,
            productCode: true,
            productName: true,
            quantity: true,
            price: true,
            product: {
              select: {
                middleName: true,
                weight: true,
                weightUnit: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const osIds = orderSuppliers.map((o) => o.id);
    const qtyMap = await this.getQuantityMap(osIds);

    // Chỉ giữ sản phẩm có nguồn gốc nhập khẩu: middleName chứa "nhập khẩu"
    // (không phân biệt hoa thường, bỏ dấu cách thừa).
    const isImported = (middleName?: string | null): boolean =>
      !!middleName && middleName.toLowerCase().includes('nhập khẩu');

    const rows: any[] = [];
    for (const os of orderSuppliers) {
      const availableItems: any[] = [];
      for (const item of os.items) {
        if (!isImported(item.product?.middleName)) continue;
        const entry = qtyMap.get(`${os.id}:${item.productId}`);
        const remaining = entry
          ? entry.ordered - entry.received - entry.shipped
          : Number(item.quantity);
        if (remaining > 0) {
          availableItems.push({
            productId: item.productId,
            productCode: item.productCode,
            productName: item.productName,
            price: Number(item.price),
            weight: item.product?.weight ? Number(item.product.weight) : 0,
            weightUnit: item.product?.weightUnit || 'kg',
            ordered: entry?.ordered ?? Number(item.quantity),
            received: entry?.received ?? 0,
            shipped: entry?.shipped ?? 0,
            remaining,
          });
        }
      }
      if (availableItems.length > 0) {
        rows.push({
          orderSupplierId: os.id,
          code: os.code,
          orderDate: os.orderDate,
          branchId: os.branchId,
          status: os.status,
          statusValue: os.statusValue,
          supplier: os.supplier,
          items: availableItems,
        });
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async create(dto: CreateVehicleShipmentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      if (!dto.branchId) {
        throw new BadRequestException(
          'Vui lòng chọn chi nhánh nhận cho phiếu ghép xe',
        );
      }
      const code = await this.resolveCode(tx, dto.code);
      const itemsData = await this.buildItemsData(tx, dto.items);
      const status = dto.status === 1 ? 1 : 0;

      const shipment = await tx.vehicleShipment.create({
        data: {
          code,
          status,
          statusValue: getVehicleShipmentStatusLabel(status),
          branchId: dto.branchId ?? null,
          borderGateId: dto.borderGateId ?? null,
          vehicleInfo: dto.vehicleInfo,
          files: (dto.files ?? undefined) as any,
          expectedArrivalDate: dto.expectedArrivalDate
            ? new Date(dto.expectedArrivalDate)
            : null,
          description: dto.description,
          createdBy: userId,
          items: { create: itemsData },
        },
        include: { items: true },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'VEHICLE_SHIPMENT_CREATE',
        entityType: 'vehicle_shipments',
        entityId: shipment.id.toString(),
        entityCode: shipment.code,
        category: getCategoryFromActionCode('VEHICLE_SHIPMENT_CREATE'),
        severity: getSeverityFromActionCode('VEHICLE_SHIPMENT_CREATE'),
        message: renderAuditMessage('VEHICLE_SHIPMENT_CREATE', {
          vehicleShipmentCode: shipment.code,
        }),
        messageTemplate: 'VEHICLE_SHIPMENT_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: shipment.branchId || user?.branchId || undefined,
      });

      return shipment;
    });
  }

  async update(id: number, dto: UpdateVehicleShipmentDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.vehicleShipment.findUnique({
        where: { id },
        include: { purchaseOrders: { where: { status: { not: 2 } } } },
      });
      if (!existing) {
        throw new NotFoundException('Không tìm thấy phiếu ghép xe');
      }
      if (existing.status === 2) {
        throw new BadRequestException(
          'Phiếu ghép xe đã nhập hàng, không thể chỉnh sửa',
        );
      }
      if (existing.status === 3) {
        throw new BadRequestException('Phiếu ghép xe đã hủy');
      }
      if (existing.purchaseOrders.length > 0) {
        throw new BadRequestException(
          'Phiếu ghép xe đã có phiếu nhập, không thể chỉnh sửa',
        );
      }

      const nextCode =
        dto.code === undefined
          ? existing.code
          : await this.resolveCode(tx, dto.code, id);

      const nextBranchId = dto.branchId ?? existing.branchId;
      if (!nextBranchId) {
        throw new BadRequestException(
          'Vui lòng chọn chi nhánh nhận cho phiếu ghép xe',
        );
      }

      let itemsUpdate: any = undefined;
      if (dto.items) {
        const itemsData = await this.buildItemsData(tx, dto.items, id);
        await tx.vehicleShipmentItem.deleteMany({
          where: { vehicleShipmentId: id },
        });
        itemsUpdate = { create: itemsData };
      }

      const nextStatus = dto.status ?? existing.status;

      const updated = await tx.vehicleShipment.update({
        where: { id },
        data: {
          code: nextCode,
          branchId: nextBranchId,
          borderGateId:
            dto.borderGateId !== undefined
              ? dto.borderGateId
              : existing.borderGateId,
          vehicleInfo: dto.vehicleInfo ?? existing.vehicleInfo,
          files: (dto.files !== undefined
            ? dto.files
            : (existing.files ?? undefined)) as any,
          expectedArrivalDate:
            dto.expectedArrivalDate !== undefined
              ? dto.expectedArrivalDate
                ? new Date(dto.expectedArrivalDate)
                : null
              : existing.expectedArrivalDate,
          description: dto.description ?? existing.description,
          status: nextStatus,
          statusValue: getVehicleShipmentStatusLabel(nextStatus),
          ...(itemsUpdate ? { items: itemsUpdate } : {}),
        },
        include: { items: true },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'VEHICLE_SHIPMENT_UPDATE',
        entityType: 'vehicle_shipments',
        entityId: id.toString(),
        entityCode: updated.code,
        category: getCategoryFromActionCode('VEHICLE_SHIPMENT_UPDATE'),
        severity: getSeverityFromActionCode('VEHICLE_SHIPMENT_UPDATE'),
        message: renderAuditMessage('VEHICLE_SHIPMENT_UPDATE', {
          vehicleShipmentCode: updated.code,
        }),
        messageTemplate: 'VEHICLE_SHIPMENT_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: updated.branchId || user?.branchId || undefined,
      });

      return updated;
    });
  }

  async cancel(id: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.vehicleShipment.findUnique({
        where: { id },
        include: { purchaseOrders: { where: { status: { not: 2 } } } },
      });
      if (!existing) {
        throw new NotFoundException('Không tìm thấy phiếu ghép xe');
      }
      if (existing.status === 3) {
        throw new BadRequestException('Phiếu ghép xe đã hủy trước đó');
      }
      if (existing.purchaseOrders.length > 0) {
        throw new BadRequestException(
          'Phiếu ghép xe đã có phiếu nhập. Vui lòng hủy các phiếu nhập trước khi hủy phiếu ghép xe.',
        );
      }

      const updated = await tx.vehicleShipment.update({
        where: { id },
        data: { status: 3, statusValue: getVehicleShipmentStatusLabel(3) },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'VEHICLE_SHIPMENT_CANCEL',
        entityType: 'vehicle_shipments',
        entityId: id.toString(),
        entityCode: existing.code,
        category: getCategoryFromActionCode('VEHICLE_SHIPMENT_CANCEL'),
        severity: getSeverityFromActionCode('VEHICLE_SHIPMENT_CANCEL'),
        message: renderAuditMessage('VEHICLE_SHIPMENT_CANCEL', {
          vehicleShipmentCode: existing.code,
        }),
        messageTemplate: 'VEHICLE_SHIPMENT_CANCEL',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: existing.branchId || user?.branchId || undefined,
      });

      return updated;
    });
  }

  /**
   * Xử lý chênh lệch sau nhập cho MỘT dòng hàng trên xe (per sản phẩm).
   * Chỉ áp dụng khi xe đã ở trạng thái "Đã nhập" (status 2).
   *   - action='returned': chuyển phần thiếu về "còn lại" (cho ghép/đặt lại)
   *   - action='kept'    : chấp nhận thiếu, không trả về
   *   - action='pending' : đưa về chưa xử lý (giữ chỗ phần thiếu)
   * Cho phép đổi lại quyết định (toggle) — backend không khóa.
   */
  async resolveItem(
    id: number,
    dto: {
      vehicleShipmentItemId?: number;
      orderSupplierId?: number;
      productId?: number;
      action: string;
    },
    userId: number,
  ) {
    const allowed = ['pending', 'returned', 'kept'];
    if (!allowed.includes(dto.action)) {
      throw new BadRequestException('Hành động xử lý không hợp lệ');
    }

    const shipment = await this.prisma.vehicleShipment.findUnique({
      where: { id },
      select: { id: true, code: true, status: true, branchId: true },
    });
    if (!shipment) {
      throw new NotFoundException('Không tìm thấy phiếu ghép xe');
    }
    if (shipment.status !== 2) {
      throw new BadRequestException(
        'Chỉ xử lý chênh lệch sau khi phiếu ghép xe đã nhập hàng',
      );
    }

    // Ưu tiên match bằng vehicleShipmentItemId (id trực tiếp của dòng) — chính
    // xác khi 1 phiếu xe có 2 dòng cùng (orderSupplierId, productId) nhưng
    // khác contractNo. Fallback (orderSupplierId, productId) cho phiếu cũ
    // (giữ backward-compat với FE chưa cập nhật).
    let item: { id: number } | null = null;
    if (dto.vehicleShipmentItemId != null) {
      item = await this.prisma.vehicleShipmentItem.findFirst({
        where: {
          id: dto.vehicleShipmentItemId,
          vehicleShipmentId: id,
        },
        select: { id: true },
      });
    } else if (dto.orderSupplierId != null && dto.productId != null) {
      item = await this.prisma.vehicleShipmentItem.findFirst({
        where: {
          vehicleShipmentId: id,
          orderSupplierId: dto.orderSupplierId,
          productId: dto.productId,
        },
        select: { id: true },
      });
    } else {
      throw new BadRequestException(
        'Thiếu vehicleShipmentItemId (hoặc orderSupplierId + productId)',
      );
    }
    if (!item) {
      throw new NotFoundException(
        'Không tìm thấy dòng hàng trên phiếu ghép xe',
      );
    }

    await this.prisma.vehicleShipmentItem.update({
      where: { id: item.id },
      data: { postImportStatus: dto.action },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, branchId: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'VEHICLE_SHIPMENT_RESOLVE_ITEM',
      entityType: 'vehicle_shipments',
      entityId: id.toString(),
      entityCode: shipment.code,
      category: getCategoryFromActionCode('VEHICLE_SHIPMENT_RESOLVE_ITEM'),
      severity: getSeverityFromActionCode('VEHICLE_SHIPMENT_RESOLVE_ITEM'),
      message: renderAuditMessage('VEHICLE_SHIPMENT_RESOLVE_ITEM', {
        vehicleShipmentCode: shipment.code,
      }),
      messageTemplate: 'VEHICLE_SHIPMENT_RESOLVE_ITEM',
      userId,
      userName: user?.name || user?.email || 'System',
      branchId: shipment.branchId || user?.branchId || undefined,
    });

    return { success: true, postImportStatus: dto.action };
  }

  /**
   * Sinh N phiếu nhập (PN) từ phiếu ghép xe — mỗi section là 1 PDN. Chạy 1 lần
   * duy nhất: sau khi sinh xong, xe chuyển sang "Đã nhập" (2) và bị khóa.
   * SL thực nhận (receivedQuantity) cho phép khác SL ghép — kho ghi theo SL
   * thực nhận qua luồng nhập hàng hiện có (createOneFromOrderSupplierTx).
   */
  async createPurchaseOrders(
    id: number,
    dto: CreatePurchaseOrdersFromVehicleDto,
    userId: number,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const shipment = await tx.vehicleShipment.findUnique({
          where: { id },
          include: { items: true },
        });
        if (!shipment) {
          throw new NotFoundException('Không tìm thấy phiếu ghép xe');
        }
        if (shipment.status === 3) {
          throw new BadRequestException('Phiếu ghép xe đã hủy');
        }
        if (shipment.status === 2) {
          throw new BadRequestException(
            'Phiếu ghép xe đã nhập hàng, không thể tạo phiếu nhập lại',
          );
        }
        if (!shipment.branchId) {
          throw new BadRequestException(
            'Phiếu ghép xe chưa có chi nhánh nhận, không thể tạo phiếu nhập',
          );
        }
        if (!dto.sections || dto.sections.length === 0) {
          throw new BadRequestException('Không có dữ liệu phiếu nhập để tạo');
        }

        const createdPOs: any[] = [];
        for (const section of dto.sections) {
          const sectionItems = (section.items || []).filter(
            (it) => Number(it.receivedQuantity) > 0,
          );
          if (sectionItems.length === 0) continue;

          // Bổ sung productCode/productName từ dòng ghép xe của PDN này.
          const items = await Promise.all(
            sectionItems.map(async (it) => {
              const shipItem = shipment.items.find(
                (s: any) =>
                  s.orderSupplierId === section.orderSupplierId &&
                  s.productId === it.productId,
              );
              let productCode = shipItem?.productCode;
              let productName = shipItem?.productName;
              let price = it.price;
              if (!productCode || !productName || price === undefined) {
                const osItem = await tx.orderSupplierItem.findFirst({
                  where: {
                    orderSupplierId: section.orderSupplierId,
                    productId: it.productId,
                  },
                  select: {
                    productCode: true,
                    productName: true,
                    price: true,
                  },
                });
                productCode = productCode || osItem?.productCode || '';
                productName = productName || osItem?.productName || '';
                if (price === undefined) price = Number(osItem?.price || 0);
              }
              const qty = Number(it.receivedQuantity);
              const discount = Number(it.discount || 0);
              const totalPrice =
                it.totalPrice !== undefined
                  ? Number(it.totalPrice)
                  : (Number(price) - discount) * qty;
              return {
                productId: it.productId,
                productCode,
                productName,
                quantity: qty,
                price: Number(price),
                discount,
                discountRatio: 0,
                totalPrice,
                description: it.description,
              };
            }),
          );

          const po =
            await this.purchaseOrdersService.createOneFromOrderSupplierTx(
              tx,
              section.orderSupplierId,
              {
                code: section.code,
                branchId: shipment.branchId ?? undefined,
                purchaseDate: section.purchaseDate,
                isDraft: section.isDraft,
                discount: section.discount,
                description: section.description,
                purchaseById: section.purchaseById,
                items,
              } as any,
              userId,
              id,
            );
          createdPOs.push(po);
        }

        if (createdPOs.length === 0) {
          throw new BadRequestException(
            'Không có dòng hàng nào có số lượng thực nhận > 0',
          );
        }

        const updatedShipment = await tx.vehicleShipment.update({
          where: { id },
          data: {
            status: 2,
            statusValue: getVehicleShipmentStatusLabel(2),
            actualArrivalDate: new Date(), // ngày xe về kho thực tế = lúc nhập hàng
          },
        });

        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'VEHICLE_SHIPMENT_CREATE_PO',
          entityType: 'vehicle_shipments',
          entityId: id.toString(),
          entityCode: shipment.code,
          category: getCategoryFromActionCode('VEHICLE_SHIPMENT_CREATE_PO'),
          severity: getSeverityFromActionCode('VEHICLE_SHIPMENT_CREATE_PO'),
          message: renderAuditMessage('VEHICLE_SHIPMENT_CREATE_PO', {
            vehicleShipmentCode: shipment.code,
            count: createdPOs.length,
          }),
          messageTemplate: 'VEHICLE_SHIPMENT_CREATE_PO',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: shipment.branchId || user?.branchId || undefined,
        });

        return { shipment: updatedShipment, purchaseOrders: createdPOs };
      },
      { timeout: 60000, maxWait: 10000 },
    );
  }
}
