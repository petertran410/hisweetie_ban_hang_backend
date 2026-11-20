import { Prisma } from '@prisma/client';

/** Lý do từ chối ghi đè hóa đơn có phiếu thu do Tiền mặt kho lập. */
export const FINANCE_OWNED_INVOICE_ERROR =
  'Hóa đơn có phiếu thu từ Tiền mặt kho, không ghi đè được';

type FinanceOwnedDb = Pick<Prisma.TransactionClient, 'internalFinanceEntry'> & {
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
};

/**
 * Phiếu thu (CashFlow) do tài chính nội bộ lập: entry.cashFlowId hoặc nằm trong
 * sourceSnapshot.postedCashFlows (Tiền mặt kho lập một phiếu thu cho mỗi khách).
 */
export async function financeOwnedCashFlowIds(
  db: FinanceOwnedDb,
  cashFlowIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(cashFlowIds.filter((id) => Number(id) > 0))];
  if (!ids.length) return new Set();
  const direct = await db.internalFinanceEntry.findMany({
    where: { cashFlowId: { in: ids } },
    select: { cashFlowId: true },
  });
  // So sánh dạng chữ để id lạ trong JSON không làm lỗi câu lệnh.
  const posted = await db.$queryRaw<Array<{ id: number | string }>>`
    SELECT DISTINCT item->>'id' AS id
    FROM internal_finance_entries entry,
      jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(entry."sourceSnapshot"->'postedCashFlows') = 'array'
            THEN entry."sourceSnapshot"->'postedCashFlows'
          ELSE '[]'::jsonb
        END
      ) AS item
    WHERE item->>'id' IN (${Prisma.join(ids.map(String))})`;
  return new Set(
    [
      ...direct.map((row) => Number(row.cashFlowId)),
      ...(posted ?? []).map((row) => Number(row.id)),
    ].filter((id) => ids.includes(id)),
  );
}

/**
 * Hóa đơn sắp bị ghi đè có thanh toán gắn phiếu thu của tài chính nội bộ: import
 * không được xóa cứng phiếu thu đó (làm mất cashFlowId của phiếu Tiền mặt kho),
 * nên từ chối các hóa đơn này.
 */
export async function financeOwnedInvoiceIds(
  db: FinanceOwnedDb,
  payments: Array<{ invoiceId: number; cashFlowId: number | null }>,
): Promise<Set<number>> {
  const owned = await financeOwnedCashFlowIds(
    db,
    payments
      .map((payment) => payment.cashFlowId)
      .filter((id): id is number => id != null),
  );
  return new Set(
    payments
      .filter(
        (payment) =>
          payment.cashFlowId != null && owned.has(payment.cashFlowId),
      )
      .map((payment) => payment.invoiceId),
  );
}
