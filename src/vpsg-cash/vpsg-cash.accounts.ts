import { Prisma } from '@prisma/client';

/**
 * Tài khoản ngân hàng nhận tiền mặt của quỹ nội bộ Văn phòng SG (đánh dấu ở
 * Cài đặt › Sổ quỹ). Tiền vào các tài khoản này không phải tiền khách: không
 * gắn khách / đơn, không tạo phiếu thu; người có quyền ghi vào quỹ VPSG.
 */

type BankAccountReader = {
  bankAccount: {
    findMany(args: {
      where: { vpsgCashFund: boolean };
      select: { accountNumber: true };
    }): Promise<Array<{ accountNumber: string }>>;
  };
};

export async function vpsgAccountNumbers(
  db: BankAccountReader,
): Promise<string[]> {
  const rows = await db.bankAccount.findMany({
    where: { vpsgCashFund: true },
    select: { accountNumber: true },
  });
  return [
    ...new Set(rows.map((row) => row.accountNumber.trim()).filter(Boolean)),
  ];
}

/**
 * Giao dịch của các tài khoản VPSG. Cùng cách khớp với bộ lọc tài khoản của
 * Biến động số dư: qua tài khoản ảo thì `subAccount`, tài khoản thường thì
 * `accountNumber` với `subAccount` rỗng.
 */
export function vpsgAccountClause(
  numbers: string[],
): Prisma.SepayTransactionWhereInput {
  return {
    OR: [
      { subAccount: { in: numbers } },
      { accountNumber: { in: numbers }, subAccount: null },
    ],
  };
}

/**
 * Ngược lại của `vpsgAccountClause`, an toàn với NULL (NOT IN gặp NULL là
 * NULL nên phải nói rõ nhánh rỗng, nếu không sẽ ẩn nhầm giao dịch thường).
 */
export function nonVpsgAccountClause(
  numbers: string[],
): Prisma.SepayTransactionWhereInput {
  return {
    AND: [
      { OR: [{ subAccount: null }, { subAccount: { notIn: numbers } }] },
      {
        OR: [
          { subAccount: { not: null } },
          { accountNumber: null },
          { accountNumber: { notIn: numbers } },
        ],
      },
    ],
  };
}

export function isVpsgTransaction(
  tx: { accountNumber: string | null; subAccount: string | null },
  numbers: string[],
) {
  if (!numbers.length) return false;
  if (tx.subAccount) return numbers.includes(tx.subAccount);
  return Boolean(tx.accountNumber && numbers.includes(tx.accountNumber));
}

/** Điều kiện SQL loại giao dịch tài khoản VPSG (bảng sepay_transactions). */
export function excludeVpsgSql(numbers: string[], alias: string) {
  if (!numbers.length) return Prisma.empty;
  const list = Prisma.join(numbers);
  const table = Prisma.raw(alias);
  return Prisma.sql`AND NOT (COALESCE(${table}.sub_account IN (${list}), false)
    OR (${table}.sub_account IS NULL AND COALESCE(${table}.account_number IN (${list}), false)))`;
}
