import { Prisma, PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, '$queryRaw'>;

function priceWarningSource(orderIds: number[]): Prisma.Sql {
  return Prisma.sql`
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN price_book_details pbd
      ON pbd."productId" = oi."productId"
     AND pbd."priceBookId" = o."priceBookId"
     AND pbd."isActive" = true
    WHERE o.id IN (${Prisma.join(orderIds)})
      AND o.status <> 4
      AND o."priceBookId" IN (2, 3)
      AND (oi.price - oi.discount) < pbd.price`;
}

/**
 * Dòng đặt hàng bán thấp hơn giá bảng giá — cùng điều kiện cảnh báo lệch giá của hóa đơn
 * (invoice-warnings.query.ts): đơn chưa hủy (status 4), dùng bảng giá buôn 2/3, sản phẩm
 * có giá đang bật trong chính bảng giá đó và (đơn giá − giảm giá dòng) < giá bảng giá.
 */
export async function findOrderPriceWarnings(db: Db, orderIds: number[]) {
  if (orderIds.length === 0) return [];
  return db.$queryRaw<
    {
      id: number;
      productCode: string;
      productName: string;
      price: Prisma.Decimal;
      listPrice: Prisma.Decimal;
    }[]
  >(Prisma.sql`
    SELECT DISTINCT o.id, oi."productCode", oi."productName",
           (oi.price - oi.discount) AS price, pbd.price AS "listPrice"
    ${priceWarningSource(orderIds)}
    ORDER BY o.id, oi."productCode"`);
}

/** Id đơn có cảnh báo lệch giá — cùng điều kiện với icon (bộ lọc "Cảnh báo đơn hàng"). */
export async function findOrderPriceWarningIds(db: Db, orderIds: number[]): Promise<number[]> {
  if (orderIds.length === 0) return [];
  const rows = await db.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT DISTINCT o.id ${priceWarningSource(orderIds)}`,
  );
  return rows.map((row) => Number(row.id));
}
