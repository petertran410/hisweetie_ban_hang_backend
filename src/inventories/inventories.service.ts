import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeBucketTotalsBatch } from '../common/stock-condition-onhand.util';

@Injectable()
export class InventoriesService {
  constructor(private prisma: PrismaService) {}

  async getInventoryByBranch(branchId: number, productIds?: number[]) {
    const where: any = { branchId };

    if (productIds && productIds.length > 0) {
      where.productId = { in: productIds };
    }

    const inventories = await this.prisma.inventory.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
            unit: true,
            isActive: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ productCode: 'asc' }],
    });

    // NGUỒN CHÂN LÝ: 3 cột bucket trên Inventory chỉ là CACHE và có thể trôi
    // khỏi sổ cái (một số module cũ — trả hàng, trả NCC, trả ký gửi, KLB/KKM,
    // sửa tình trạng thủ công — còn ghi trực tiếp vào cột cache mà không ghi
    // sổ). Vì vậy ghi đè 3 cột này TRONG RESPONSE bằng số tính từ
    // StockConditionLog, để mọi màn đọc endpoint này (giỏ hàng POS...) luôn
    // khớp tab "Thẻ kho loại tồn". KHÔNG ghi DB ở đây.
    if (inventories.length === 0) return inventories;

    const totalsMap = await computeBucketTotalsBatch(
      this.prisma,
      inventories.map((inv) => inv.productId),
      branchId,
    );

    return inventories.map((inv) => {
      const totals = totalsMap[inv.productId];
      if (!totals) return inv;
      return {
        ...inv,
        damagedQuantity: totals.damaged as any,
        nearExpiryQuantity: totals.nearExpiry as any,
        promoQuantity: totals.promo as any,
      };
    });
  }

  async getProductInventoryAcrossBranches(productId: number) {
    return this.prisma.inventory.findMany({
      where: { productId },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
            unit: true,
          },
        },
      },
      orderBy: [{ branchName: 'asc' }],
    });
  }

  async updateInventory(
    productId: number,
    branchId: number,
    data: {
      cost?: number;
      onHand?: number;
      reserved?: number;
      onOrder?: number;
      minQuality?: number;
      maxQuality?: number;
    },
  ) {
    const inventory = await this.prisma.inventory.findUnique({
      where: {
        productId_branchId: {
          productId,
          branchId,
        },
      },
      include: {
        product: {
          select: {
            weight: true,
            weightUnit: true,
          },
        },
      },
    });

    if (!inventory) {
      throw new Error(
        `Inventory not found for product ${productId} at branch ${branchId}`,
      );
    }

    const updateData: any = { ...data };

    if (data.onHand !== undefined) {
      const weight = inventory.product.weight
        ? Number(inventory.product.weight)
        : 0;
      const onHand = Number(data.onHand);
      updateData.totalWeight = weight * onHand;
    }

    return this.prisma.inventory.update({
      where: {
        productId_branchId: {
          productId,
          branchId,
        },
      },
      data: updateData,
    });
  }

  async createInventory(data: {
    productId: number;
    productCode: string;
    productName: string;
    branchId: number;
    branchName: string;
    cost?: number;
    onHand?: number;
    minQuality?: number;
    maxQuality?: number;
  }) {
    const product = await this.prisma.product.findUnique({
      where: { id: data.productId },
      select: {
        weight: true,
        weightUnit: true,
      },
    });

    const weight = product?.weight ? Number(product.weight) : 0;
    const onHand = data.onHand || 0;
    const totalWeight = weight * onHand;

    return this.prisma.inventory.create({
      data: {
        productId: data.productId,
        productCode: data.productCode,
        productName: data.productName,
        branchId: data.branchId,
        branchName: data.branchName,
        cost: data.cost || 0,
        onHand: onHand,
        reserved: 0,
        onOrder: 0,
        minQuality: data.minQuality || 0,
        maxQuality: data.maxQuality || 0,
        totalWeight: totalWeight,
      },
    });
  }

  async getLowStockProducts(branchId?: number) {
    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    const allInventories = await this.prisma.inventory.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return allInventories.filter(
      (inv) => Number(inv.onHand) <= Number(inv.minQuality),
    );
  }

  // ĐÃ NGỪNG SỬ DỤNG — thay thế bằng "Chuyển loại tồn" (CLT).
  //
  // Bản cũ GHI ĐÈ tuyệt đối vào cột cache Inventory.damagedQuantity /
  // nearExpiryQuantity mà KHÔNG ghi sổ cái StockConditionLog. Từ khi tồn bucket
  // được dẫn xuất từ sổ cái (tồn bucket = Σ log active), ghi đè ở đây sẽ khiến
  // cache trôi khỏi sổ cái và sinh ra chênh lệch không thể tự kéo về.
  //
  // Frontend đã không còn gọi endpoint này (editor tình trạng cũ trên trang
  // sản phẩm đã được bỏ ở GĐ1). Giữ lại endpoint trả lỗi rõ ràng thay vì xóa
  // để client cũ (nếu còn) nhận được thông báo hướng dẫn.
  async updateProductCondition(
    _productId: number,
    _branchId: number,
    _data: { damagedQuantity?: number; nearExpiryQuantity?: number },
    _userId?: number,
  ): Promise<never> {
    throw new BadRequestException(
      'Chỉnh sửa tình trạng hàng trực tiếp đã ngừng sử dụng. Vui lòng dùng "Chuyển loại tồn" (CLT) để điều chỉnh hàng bục rách / cận date / khuyến mãi.',
    );
  }
}
