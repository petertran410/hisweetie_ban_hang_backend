import { Prisma, PrismaClient } from '@prisma/client';

export interface InvoiceQuantityMismatchItem {
  productCode: string;
  productName: string;
  unit: string | null;
  /** Tổng SL trên đơn đặt hàng. */
  orderQuantity: number;
  /** SL đã xuất ở các hóa đơn trước (cùng đơn, chưa hủy). */
  previousQuantity: number;
  /** SL cần giao ở hóa đơn này = max(đặt − đã xuất trước, 0). */
  expectedQuantity: number;
  invoiceQuantity: number;
}

export interface InvoiceQuantityMismatch {
  orderCode: string;
  /** Hóa đơn trước của cùng đơn đặt (đơn tách giao). */
  previousInvoiceCodes: string[];
  items: InvoiceQuantityMismatchItem[];
}

type Db = Pick<PrismaClient, '$queryRaw'>;

export function invoiceQuantityMismatchCtes(invoiceIds: number[]): Prisma.Sql {
  return Prisma.sql`
    inv AS (
      SELECT i.id, i."orderId", i."createdAt" FROM invoices i
      WHERE i.id IN (${Prisma.join(invoiceIds)})
        AND i.status <> 2 AND i."orderId" IS NOT NULL
    ),
    prev_inv AS (
      SELECT inv.id, p.id AS prev_id, p.code
      FROM inv JOIN invoices p
        ON p."orderId" = inv."orderId" AND p.status <> 2
       AND (p."createdAt", p.id) < (inv."createdAt", inv.id)
    ),
    lines AS (
      SELECT inv.id, 'i' AS src, COALESCE(d."productId", 0) AS pid,
             d."productCode" AS code, d."productName" AS name, d.quantity AS q
      FROM inv JOIN invoice_details d ON d."invoiceId" = inv.id
      UNION ALL
      SELECT inv.id, 'o', oi."productId", oi."productCode", oi."productName", oi.quantity
      FROM inv JOIN order_items oi ON oi."orderId" = inv."orderId"
      UNION ALL
      SELECT pi.id, 'p', COALESCE(d."productId", 0), d."productCode", d."productName", d.quantity
      FROM prev_inv pi JOIN invoice_details d ON d."invoiceId" = pi.prev_id
    ),
    agg AS (
      SELECT id, pid, min(code) AS code, min(name) AS name,
             COALESCE(sum(q) FILTER (WHERE src = 'o'), 0) AS oq,
             COALESCE(sum(q) FILTER (WHERE src = 'p'), 0) AS pq,
             COALESCE(sum(q) FILTER (WHERE src = 'i'), 0) AS iq
      FROM lines GROUP BY id, pid
    )`;
}

export const invoiceQuantityMismatchCondition = Prisma.sql`
  a.iq <> GREATEST(a.oq - a.pq, 0)`;

/**
 * So SL từng sản phẩm của hóa đơn với đơn đặt hàng gốc. `quantity` luôn lưu theo
 * đơn vị cơ bản (quantityUnit chỉ là đơn vị hiển thị) nên cộng thẳng.
 *
 * Đơn tách giao (ĐH → HĐ1 + HĐ2): HĐ1 so với SL đặt; HĐ2 so với SL còn lại
 * = SL đặt − SL các hóa đơn trước (theo createdAt, id; bỏ hóa đơn đã hủy).
 * Bỏ qua hóa đơn đã hủy hoặc không có đơn đặt.
 */
export async function findInvoiceQuantityMismatches(
  db: Db,
  invoiceIds: number[],
): Promise<Map<number, InvoiceQuantityMismatch>> {
  const result = new Map<number, InvoiceQuantityMismatch>();
  if (invoiceIds.length === 0) return result;

  const rows = await db.$queryRaw<
    {
      id: number;
      orderCode: string;
      previousCodes: string[] | null;
      productCode: string;
      productName: string;
      unit: string | null;
      orderQuantity: Prisma.Decimal | null;
      previousQuantity: Prisma.Decimal | null;
      invoiceQuantity: Prisma.Decimal | null;
    }[]
  >(Prisma.sql`
    WITH ${invoiceQuantityMismatchCtes(invoiceIds)}
    SELECT a.id, o.code AS "orderCode",
           (SELECT array_agg(pi.code ORDER BY pi.prev_id) FROM prev_inv pi WHERE pi.id = a.id) AS "previousCodes",
           a.code AS "productCode", a.name AS "productName", pr.unit,
           a.oq AS "orderQuantity", a.pq AS "previousQuantity", a.iq AS "invoiceQuantity"
    FROM agg a
    JOIN inv ON inv.id = a.id
    JOIN orders o ON o.id = inv."orderId"
    LEFT JOIN products pr ON pr.id = NULLIF(a.pid, 0)
    WHERE ${invoiceQuantityMismatchCondition}
    ORDER BY a.id, a.code`);

  for (const row of rows) {
    const id = Number(row.id);
    let entry = result.get(id);
    if (!entry) {
      entry = {
        orderCode: row.orderCode,
        previousInvoiceCodes: row.previousCodes ?? [],
        items: [],
      };
      result.set(id, entry);
    }
    const orderQuantity = Number(row.orderQuantity ?? 0);
    const previousQuantity = Number(row.previousQuantity ?? 0);
    entry.items.push({
      productCode: row.productCode,
      productName: row.productName,
      unit: row.unit,
      orderQuantity,
      previousQuantity,
      expectedQuantity: Math.max(orderQuantity - previousQuantity, 0),
      invoiceQuantity: Number(row.invoiceQuantity ?? 0),
    });
  }
  return result;
}
