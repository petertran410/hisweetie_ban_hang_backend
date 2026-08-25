import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Múi giờ nghiệp vụ — mọi ranh giới "ngày" đều tính theo giờ Việt Nam. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Số bản ghi ghi xuống DB mỗi lô — tránh câu lệnh quá lớn. */
const WRITE_CHUNK = 1000;

export interface SnapshotResult {
  date: string;
  branchIds: number[];
  written: number;
  skipped: number;
}

/**
 * Chốt tồn kho cuối ngày theo (sản phẩm × chi nhánh).
 *
 * Lý do tồn tại: forecast engine cần biết một ngày SKU có hàng hay không để
 * lấy đúng mẫu số khi tính moving average. Không có dữ liệu này, engine phải
 * suy đoán `hadStock = demand > 0` — khiến ngày hết hàng bị coi là ngày nhu
 * cầu bằng 0, kéo dự báo xuống thấp hơn thực tế, và mọi SKU bị hạ một bậc
 * độ tin cậy.
 */
@Injectable()
export class InventorySnapshotService {
  private readonly logger = new Logger(InventorySnapshotService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Quy một mốc thời gian về "ngày" theo giờ VN, trả về Date ở UTC midnight
   * để khớp kiểu `@db.Date` của Prisma.
   */
  static toVnDate(value: Date | string): Date {
    const source = value instanceof Date ? value : new Date(value);
    const vnMs = source.getTime() + VN_OFFSET_MS;
    const vn = new Date(vnMs);
    return new Date(
      Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()),
    );
  }

  static toDateKey(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  /**
   * Tất cả chi nhánh đang hoạt động phải có snapshot: đề xuất đặt hàng nhìn
   * toàn mạng lưới, không chỉ chi nhánh gốc. `isPurchasingHub` chỉ còn là
   * điểm nhận hàng sau thông quan, không phải phạm vi forecast.
   */
  async getPlanningBranchIds(): Promise<number[]> {
    const branches = await this.prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return branches.map((branch) => branch.id);
  }

  /**
   * Chốt tồn kho hiện tại thành snapshot của `date`.
   *
   * Idempotent: chạy lại cùng một ngày sẽ ghi đè bằng số mới nhất, nhờ
   * unique `(productId, branchId, date)`. Vì vậy an toàn khi cron chạy lại
   * sau khi service restart.
   *
   * @param branchIds Bỏ trống → chốt toàn bộ chi nhánh active.
   */
  async captureDailySnapshot(
    date?: Date,
    branchIds?: number[],
  ): Promise<SnapshotResult> {
    const targetDate = InventorySnapshotService.toVnDate(date ?? new Date());
    const dateKey = InventorySnapshotService.toDateKey(targetDate);

    const scope =
      branchIds && branchIds.length > 0
        ? branchIds
        : await this.getPlanningBranchIds();

    if (scope.length === 0) {
      this.logger.warn(
        'Không có chi nhánh active — bỏ qua chốt snapshot.',
      );
      return { date: dateKey, branchIds: [], written: 0, skipped: 0 };
    }

    const inventories = await this.prisma.inventory.findMany({
      where: { branchId: { in: scope } },
      select: { productId: true, branchId: true, onHand: true },
    });

    let written = 0;
    for (let i = 0; i < inventories.length; i += WRITE_CHUNK) {
      const chunk = inventories.slice(i, i + WRITE_CHUNK);
      await this.prisma.$transaction(
        chunk.map((row) => {
          const onHand = row.onHand ?? 0;
          const hadStock = Number(onHand) > 0;
          return this.prisma.inventoryDailySnapshot.upsert({
            where: {
              productId_branchId_date: {
                productId: row.productId,
                branchId: row.branchId,
                date: targetDate,
              },
            },
            create: {
              productId: row.productId,
              branchId: row.branchId,
              date: targetDate,
              onHand,
              hadStock,
            },
            update: { onHand, hadStock },
          });
        }),
      );
      written += chunk.length;
    }

    this.logger.log(
      `Chốt tồn kho ngày ${dateKey}: ${written} bản ghi trên ${scope.length} chi nhánh.`,
    );

    return {
      date: dateKey,
      branchIds: scope,
      written,
      skipped: 0,
    };
  }

  /**
   * Đọc lịch sử `hadStock` phục vụ forecast engine.
   *
   * Gộp theo sản phẩm × ngày trên toàn bộ chi nhánh trong phạm vi: SKU được
   * coi là "có hàng" nếu **bất kỳ** kho nào còn hàng — khớp với cách engine
   * cộng gộp tồn kho các kho đầu mối khi tính vị thế tồn.
   */
  async getStockHistory(
    productIds: number[],
    branchIds: number[],
    from: Date,
    to: Date,
  ): Promise<Map<number, Map<string, boolean>>> {
    const result = new Map<number, Map<string, boolean>>();
    if (productIds.length === 0 || branchIds.length === 0) return result;

    const rows = await this.prisma.inventoryDailySnapshot.findMany({
      where: {
        productId: { in: productIds },
        branchId: { in: branchIds },
        date: {
          gte: InventorySnapshotService.toVnDate(from),
          lte: InventorySnapshotService.toVnDate(to),
        },
      },
      select: { productId: true, date: true, hadStock: true },
    });

    for (const row of rows) {
      let byDate = result.get(row.productId);
      if (!byDate) {
        byDate = new Map<string, boolean>();
        result.set(row.productId, byDate);
      }
      const key = InventorySnapshotService.toDateKey(row.date);
      byDate.set(key, (byDate.get(key) ?? false) || row.hadStock);
    }

    return result;
  }

  /** Ngày snapshot cũ nhất/mới nhất — dùng để biết dữ liệu đã phủ tới đâu. */
  async getCoverage(): Promise<{ from: string | null; to: string | null }> {
    const [oldest, newest] = await Promise.all([
      this.prisma.inventoryDailySnapshot.findFirst({
        orderBy: { date: 'asc' },
        select: { date: true },
      }),
      this.prisma.inventoryDailySnapshot.findFirst({
        orderBy: { date: 'desc' },
        select: { date: true },
      }),
    ]);
    return {
      from: oldest ? InventorySnapshotService.toDateKey(oldest.date) : null,
      to: newest ? InventorySnapshotService.toDateKey(newest.date) : null,
    };
  }
}
