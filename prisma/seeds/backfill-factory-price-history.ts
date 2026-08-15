import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PURCHASE_ORDER_REASON_PREFIX = 'Giá đặt hàng nhập ';

const toVnd = (
  price: { toNumber(): number } | null,
  currency: string,
  exchangeRate: { toNumber(): number } | null,
) => {
  if (price == null) return null;
  if (currency.toUpperCase() === 'VND') return price.toNumber();
  if (exchangeRate == null) return null;
  return price.toNumber() * exchangeRate.toNumber();
};

async function main() {
  const histories = await prisma.factory_product_price_histories.findMany({
    orderBy: [{ factoryProductId: 'asc' }, { createdAt: 'asc' }],
  });
  let updated = 0;

  for (const history of histories) {
    const isPurchaseOrder = history.reason?.startsWith(
      PURCHASE_ORDER_REASON_PREFIX,
    );
    const eventType = isPurchaseOrder ? 'purchase_order' : 'reference';
    const refCode = isPurchaseOrder
      ? history.reason?.slice(PURCHASE_ORDER_REASON_PREFIX.length).trim() || null
      : null;
    const oldPriceVnd = toVnd(
      history.oldPrice,
      history.currency,
      history.exchangeRate,
    );
    const newPriceVnd = toVnd(
      history.newPrice,
      history.currency,
      history.exchangeRate,
    );

    await prisma.factory_product_price_histories.update({
      where: { id: history.id },
      data: { eventType, refCode, oldPriceVnd, newPriceVnd },
    });
    updated++;
  }

  console.log(`Backfilled ${updated} factory price history record(s).`);
}

main()
  .catch((error) => {
    console.error('Factory price history backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
