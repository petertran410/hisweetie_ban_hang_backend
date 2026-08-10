import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncKiotApiService } from '../sync-kiot-api.service';
import { BaseSyncService } from './base-sync.service';
import { LarkProductSyncService } from '../../lark-sync/services/lark-product-sync.service';

@Injectable()
export class SyncProductService extends BaseSyncService {
  protected readonly entityName = 'product';
  protected readonly endpoint = 'products';

  constructor(
    prisma: PrismaService,
    api: SyncKiotApiService,
    private readonly larkProductSync: LarkProductSyncService,
  ) {
    super(prisma, api);
  }

  async syncByCode(code: string): Promise<any> {
    const record = await this.api.fetchByCode('products', code);
    if (!record) return null;
    return this.upsertRecord(record);
  }

  /**
   * ⚠️ PHẠM VI ĐỒNG BỘ SẢN PHẨM (theo yêu cầu nghiệp vụ):
   * - CHỈ cập nhật DUY NHẤT trường `type` trên bảng Product.
   *   + KiotViet type=1 (combo)            → backend 1 (giữ nguyên)
   *   + KiotViet type=3 (dịch vụ)          → backend 3
   *   + KiotViet type=2 CÓ productFormulas → backend 4 (hàng sản xuất)
   *   + KiotViet type=2 KHÔNG có formula   → backend 2 (hàng hóa)
   * - Với hàng sản xuất (type=4): dựng liên kết hàng thành phần vào bảng
   *   ProductComponent (từ record.formulas của sync_kiot_data).
   * - TUYỆT ĐỐI KHÔNG đụng: các trường khác của Product, bảng Inventory,
   *   bảng product_images, giá vốn/giá bán/tồn kho.
   * - KHÔNG tạo mới sản phẩm: chỉ xử lý sản phẩm đã tồn tại trong backend.
   *   Sản phẩm chưa có → skip.
   */
  protected async upsertRecord(
    record: any,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.prisma.product.findFirst({
      where: {
        OR: [
          { code: record.code },
          ...(record.kiotVietId
            ? [{ kiotVietId: BigInt(record.kiotVietId) }]
            : []),
        ],
      },
      select: { id: true, type: true },
    });

    // Không tạo mới — sản phẩm chưa tồn tại trong backend thì bỏ qua.
    if (!existing) {
      return 'skipped';
    }

    const formulas: any[] = Array.isArray(record.formulas)
      ? record.formulas
      : [];
    const hasFormulas = formulas.length > 0;

    // Map type từ KiotViet → backend.
    const targetType = this.resolveBackendType(record.type, hasFormulas);

    // CHỈ cập nhật trường type trên Product.
    await this.prisma.product.update({
      where: { id: existing.id },
      data: { type: targetType },
    });

    // Dựng liên kết hàng thành phần cho hàng sản xuất (type=4).
    if (targetType === 4) {
      await this.syncProductComponents(existing.id, formulas);
    }

    // Đẩy sản phẩm lên Lark (debounce, fire-and-forget).
    this.larkProductSync.enqueueSync(existing.id);

    // ───────────────────────────────────────────────────────────────
    // ❌ KHÔNG đồng bộ tồn kho / hình ảnh (theo yêu cầu — đã bỏ hẳn).
    // if (record.inventories?.length) {
    //   await this.syncInventories(
    //     existing.id,
    //     record.code,
    //     record.name,
    //     record.inventories,
    //   );
    // }
    // if (record.images?.length) {
    //   await this.syncImages(existing.id, record.images);
    // }
    // ───────────────────────────────────────────────────────────────

    return 'updated';
  }

  /**
   * KiotViet type → backend type.
   * - 1 (combo)  → 1
   * - 3 (dịch vụ)→ 3
   * - 2          → 4 nếu có công thức (hàng sản xuất), ngược lại 2
   */
  private resolveBackendType(
    kiotType: number | null | undefined,
    hasFormulas: boolean,
  ): number {
    if (kiotType === 1) return 1;
    if (kiotType === 3) return 3;
    // kiotType === 2 hoặc null/undefined
    return hasFormulas ? 4 : 2;
  }

  /**
   * Đồng bộ sạch ProductComponent (hàng thành phần) cho 1 hàng sản xuất.
   * - Xóa hết liên kết cũ, tạo lại từ formulas.
   * - Mỗi materialCode → tra product backend theo code. Không tìm thấy → bỏ qua.
   * - inputMode mặc định 'gram'.
   */
  private async syncProductComponents(
    comboProductId: number,
    formulas: any[],
  ): Promise<void> {
    await this.prisma.productComponent.deleteMany({
      where: { comboProductId },
    });

    if (!formulas.length) return;

    const materialCodes = [
      ...new Set(
        formulas
          .map((f) => f.materialCode?.trim())
          .filter((c): c is string => !!c),
      ),
    ];

    if (!materialCodes.length) return;

    const components = await this.prisma.product.findMany({
      where: { code: { in: materialCodes } },
      select: { id: true, code: true },
    });
    const codeToId = new Map(components.map((c) => [c.code, c.id]));

    const rows: {
      comboProductId: number;
      componentProductId: number;
      quantity: any;
      inputMode: string;
    }[] = [];
    const seen = new Set<number>();

    for (const f of formulas) {
      const code = f.materialCode?.trim();
      if (!code) continue;

      const componentProductId = codeToId.get(code);
      if (!componentProductId) {
        this.logger.warn(
          `⚠️ ProductComponent: material ${code} không tồn tại trong backend, bỏ qua (combo product id=${comboProductId})`,
        );
        continue;
      }

      // Tránh trùng (unique comboProductId + componentProductId)
      if (seen.has(componentProductId)) continue;
      seen.add(componentProductId);

      rows.push({
        comboProductId,
        componentProductId,
        quantity: f.quantity ?? 0,
        inputMode: 'gram',
      });
    }

    if (rows.length) {
      await this.prisma.productComponent.createMany({ data: rows });
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // ❌ ĐÃ BỎ: đồng bộ tồn kho. Giữ lại dạng comment để truy vết.
  // private async syncInventories(
  //   productId: number,
  //   productCode: string,
  //   productName: string,
  //   inventories: any[],
  // ) {
  //   for (const inv of inventories) {
  //     const kiotVietId = inv.branchKiotVietId;
  //     if (!kiotVietId) {
  //       this.logger.warn(
  //         `⚠️ Inventory: branchKiotVietId missing for product ${productCode}, skipping`,
  //       );
  //       continue;
  //     }
  //
  //     const branch = await this.prisma.branch.findFirst({
  //       where: { kiotVietId },
  //       select: { id: true, name: true },
  //     });
  //     if (!branch) continue;
  //
  //     await this.prisma.inventory.upsert({
  //       where: {
  //         productId_branchId: { productId, branchId: branch.id },
  //       },
  //       update: {
  //         cost: inv.cost || 0,
  //         onHand: inv.onHand || 0,
  //         reserved: inv.reserved || 0,
  //         onOrder: inv.onOrder || 0,
  //         productCode,
  //         productName,
  //       },
  //       create: {
  //         productId,
  //         productCode,
  //         productName,
  //         branchId: branch.id,
  //         branchName: branch.name,
  //         cost: inv.cost || 0,
  //         onHand: inv.onHand || 0,
  //         reserved: inv.reserved || 0,
  //         onOrder: inv.onOrder || 0,
  //       },
  //     });
  //   }
  // }
  //
  // ❌ ĐÃ BỎ: đồng bộ hình ảnh. Giữ lại dạng comment để truy vết.
  // private async syncImages(productId: number, images: any[]) {
  //   await this.prisma.productImage.deleteMany({ where: { productId } });
  //
  //   for (const img of images) {
  //     let imageUrl: string | null = null;
  //
  //     if (typeof img.imageUrl === 'string') {
  //       imageUrl = img.imageUrl;
  //     } else if (img.imageUrl && typeof img.imageUrl === 'object') {
  //       imageUrl =
  //         img.imageUrl.url ?? img.imageUrl.imageUrl ?? img.imageUrl.src ?? null;
  //     }
  //
  //     if (!imageUrl) continue;
  //
  //     await this.prisma.productImage.create({
  //       data: { productId, image: imageUrl },
  //     });
  //   }
  // }
  // ───────────────────────────────────────────────────────────────────
}
