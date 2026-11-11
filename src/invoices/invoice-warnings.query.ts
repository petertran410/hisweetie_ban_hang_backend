import { Prisma, PrismaClient } from '@prisma/client';
import {
  invoiceQuantityMismatchCondition,
  invoiceQuantityMismatchCtes,
} from './invoice-quantity-mismatch';

type Db = Pick<PrismaClient, '$queryRaw'>;

function priceWarningSource(invoiceIds: number[]): Prisma.Sql {
  return Prisma.sql`
    FROM invoices i
    JOIN invoice_details d ON d."invoiceId" = i.id
    JOIN price_book_details pbd
      ON pbd."productId" = d."productId"
     AND pbd."priceBookId" = i."priceBookId"
     AND pbd."isActive" = true
    WHERE i.id IN (${Prisma.join(invoiceIds)})
      AND i.status <> 2
      AND i."priceBookId" IN (2, 3)
      AND (d.price - d.discount) < pbd.price`;
}

export async function findInvoicePriceWarnings(db: Db, invoiceIds: number[]) {
  if (invoiceIds.length === 0) return [];
  return db.$queryRaw<
    {
      id: number;
      productCode: string;
      productName: string;
      price: Prisma.Decimal;
      listPrice: Prisma.Decimal;
    }[]
  >(Prisma.sql`
    SELECT DISTINCT i.id, d."productCode", d."productName",
           (d.price - d.discount) AS price, pbd.price AS "listPrice"
    ${priceWarningSource(invoiceIds)}`);
}

export async function findInvoiceWarningIds(
  db: Db,
  invoiceIds: number[],
  includeQuantity: boolean,
): Promise<number[]> {
  if (invoiceIds.length === 0) return [];

  const priceQuery = Prisma.sql`
    SELECT DISTINCT i.id ${priceWarningSource(invoiceIds)}`;
  const query = includeQuantity
    ? Prisma.sql`
        WITH ${invoiceQuantityMismatchCtes(invoiceIds)}
        ${priceQuery}
        UNION
        SELECT a.id FROM agg a WHERE ${invoiceQuantityMismatchCondition}`
    : priceQuery;
  const rows = await db.$queryRaw<{ id: number }[]>(query);
  return rows.map((row) => Number(row.id));
}
