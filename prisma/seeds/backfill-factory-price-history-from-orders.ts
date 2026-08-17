import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Bù lịch sử giá nhà máy từ PĐN cũ tạo trước tính năng Price Tracking.
 *
 * Chỉ xét PĐN đã từng được xác nhận: status 1 (confirmed), 2 (partial),
 * hoặc 3 (completed). Phiếu nháp/hủy không được đụng tới.
 *
 * Mặc định là DRY-RUN: chỉ đọc và in thống kê, không ghi database.
 * Dùng --apply mới tạo mapping thiếu và thêm history events.
 *
 * Chạy thử:  yarn backfill:factory-price-history-from-orders
 * Chạy thật:  yarn backfill:factory-price-history-from-orders --apply
 */

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const CONFIRMED_STATUSES = [1, 2, 3];
const PURCHASE_ORDER_REASON_PREFIX = 'Giá đặt hàng nhập ';

type Stats = {
  ordersScanned: number;
  itemsScanned: number;
  skippedMissingFactory: number;
  skippedMissingPrice: number;
  existingHistories: number;
  mappingsToCreate: number;
  historiesToCreate: number;
};

const toVnd = (
  price: Prisma.Decimal | number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: Prisma.Decimal | number | null | undefined,
) => {
  if (price == null) return null;
  const value = new Prisma.Decimal(price);
  if ((currency || 'VND').toUpperCase() === 'VND') return value;
  if (exchangeRate == null) return null;
  return value.mul(new Prisma.Decimal(exchangeRate));
};

async function main() {
  const orders = await prisma.orderSupplier.findMany({
    where: { status: { in: CONFIRMED_STATUSES } },
    orderBy: [{ orderDate: 'asc' }, { id: 'asc' }],
    include: {
      items: true,
      creator: { select: { id: true, name: true } },
    },
  });

  const stats: Stats = {
    ordersScanned: orders.length,
    itemsScanned: 0,
    skippedMissingFactory: 0,
    skippedMissingPrice: 0,
    existingHistories: 0,
    mappingsToCreate: 0,
    historiesToCreate: 0,
  };
  const plannedMappings = new Set<string>();
  const plannedHistories = new Set<string>();

  const processOrders = async (
    tx: Prisma.TransactionClient | PrismaClient,
    apply: boolean,
  ) => {
    for (const order of orders) {
      const currency = (order.currency || 'VND').toUpperCase();
      const exchangeRate =
        order.exchangeRate ?? (currency === 'VND' ? 1 : null);
      const reason = `${PURCHASE_ORDER_REASON_PREFIX}${order.code}`;

      for (const item of order.items) {
        stats.itemsScanned++;
        if (item.factoryId == null) {
          stats.skippedMissingFactory++;
          continue;
        }
        if (item.factoryPrice == null) {
          stats.skippedMissingPrice++;
          continue;
        }

        const mappingKey = `${item.factoryId}:${item.productId}`;
        const historyKey = `${mappingKey}:${order.code}`;
        let mapping = await tx.factory_products.findUnique({
          where: {
            factoryId_productId: {
              factoryId: item.factoryId,
              productId: item.productId,
            },
          },
        });

        if (!mapping) {
          if (!plannedMappings.has(mappingKey)) {
            stats.mappingsToCreate++;
            plannedMappings.add(mappingKey);
          }
          if (!apply) {
            // Dry-run: mapping chưa tồn tại nên chưa có history nào để trùng.
            // Vẫn phải đếm event dự kiến, chống đếm lặp trong cùng lần chạy.
            if (!plannedHistories.has(historyKey)) {
              plannedHistories.add(historyKey);
              stats.historiesToCreate++;
            }
            continue;
          }
          mapping = await tx.factory_products.create({
            data: {
              factoryId: item.factoryId,
              productId: item.productId,
              currency,
              exchangeRate,
              isManualRate: false,
              createdBy: order.createdBy,
              updatedAt: order.orderDate,
            },
          });
        }

        if (plannedHistories.has(historyKey)) {
          continue;
        }
        const duplicate = await tx.factory_product_price_histories.findFirst({
          where: {
            factoryProductId: mapping.id,
            OR: [
              { eventType: 'purchase_order', refCode: order.code },
              { reason },
            ],
          },
          select: { id: true },
        });
        if (duplicate) {
          stats.existingHistories++;
          continue;
        }

        stats.historiesToCreate++;
        plannedHistories.add(historyKey);
        if (!apply) continue;

        const previous = await tx.factory_product_price_histories.findFirst({
          where: {
            factoryProductId: mapping.id,
            eventType: 'purchase_order',
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { newPrice: true, newPriceVnd: true },
        });
        await tx.factory_product_price_histories.create({
          data: {
            factoryProductId: mapping.id,
            oldPrice: previous?.newPrice ?? mapping.referencePrice,
            newPrice: item.factoryPrice,
            oldPriceVnd:
              previous?.newPriceVnd ??
              toVnd(
                mapping.referencePrice,
                mapping.currency,
                mapping.exchangeRate,
              ),
            newPriceVnd: toVnd(item.factoryPrice, currency, exchangeRate),
            currency,
            exchangeRate,
            eventType: 'purchase_order',
            refCode: order.code,
            reason,
            changedById: order.creator.id,
            changedByName: order.creator.name,
            createdAt: order.orderDate,
          },
        });
      }
    }
  };

  if (APPLY) {
    await prisma.$transaction(async (tx) => processOrders(tx, true), {
      timeout: 120_000,
    });
  } else {
    await processOrders(prisma, false);
  }

  console.table({
    mode: APPLY ? 'APPLY — đã ghi dữ liệu' : 'DRY-RUN — không ghi dữ liệu',
    ordersScanned: stats.ordersScanned,
    itemsScanned: stats.itemsScanned,
    skippedMissingFactory: stats.skippedMissingFactory,
    skippedMissingPrice: stats.skippedMissingPrice,
    existingHistories: stats.existingHistories,
    mappingsToCreate: stats.mappingsToCreate,
    historiesToCreate: stats.historiesToCreate,
  });

  if (!APPLY) {
    console.log('\nDry-run hoàn tất. Không có dữ liệu nào bị ghi.');
    console.log(
      'Sau khi kiểm tra thống kê, chạy lại với --apply để thực hiện.',
    );
  }
}

main()
  .catch((error) => {
    console.error('Order supplier price-history backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
