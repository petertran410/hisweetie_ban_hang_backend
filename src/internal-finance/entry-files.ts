import { Prisma } from '@prisma/client';
import type {
  InternalFinanceAttachment,
  InternalFinanceInvoiceLink,
} from '@prisma/client';

// Chứng từ và liên kết hóa đơn của phiếu: gỡ thì giữ dòng (removedAt/removedBy),
// không xóa cứng. Mọi chỗ đọc phải lọc dòng đã gỡ.

/** Điều kiện dòng còn dùng (chưa gỡ). */
export const ACTIVE_ROW = { removedAt: null } as const;

/** `include: { attachments: activeAttachments }`: không include cả dòng đã gỡ. */
export const activeAttachments = {
  where: ACTIVE_ROW,
  orderBy: { id: 'asc' as const },
};

type WithActiveRow<T> = Omit<T, 'where'> & {
  where: (T extends { where: infer W } ? W : unknown) & typeof ACTIVE_ROW;
};

/**
 * `include: { invoiceLinks: activeInvoiceLinks({ include: ... }) }`: thêm điều
 * kiện chưa gỡ, gộp với `where` truyền vào (nếu có).
 */
export function activeInvoiceLinks(): { where: typeof ACTIVE_ROW };
export function activeInvoiceLinks<const T extends object>(
  rest: T,
): WithActiveRow<T>;
export function activeInvoiceLinks(rest?: object) {
  const where = (rest as { where?: object } | undefined)?.where;
  return { ...(rest ?? {}), where: { ...(where ?? {}), ...ACTIVE_ROW } };
}

export interface DesiredAttachment {
  kind?: string | null;
  fileUrl: string;
  fileName?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
}

export interface DesiredInvoiceLink {
  invoiceId: number;
  amount?: Prisma.Decimal | number | string | null;
}

type AttachmentDb = Pick<Prisma.TransactionClient, 'internalFinanceAttachment'>;
type InvoiceLinkDb = Pick<
  Prisma.TransactionClient,
  'internalFinanceInvoiceLink'
>;

const DEFAULT_KIND = 'EVIDENCE';

function attachmentKey(file: { kind?: string | null; fileUrl: string }) {
  return `${file.kind || DEFAULT_KIND}|${file.fileUrl}`;
}

/**
 * Đồng bộ chứng từ của phiếu theo danh sách mong muốn (trong transaction của
 * thao tác sửa). Khóa so khớp `${kind}|${fileUrl}`; danh sách được khử trùng.
 * Dòng không còn trong danh sách → gỡ (removedAt, removedBy); dòng mới → tạo
 * (createdBy = người sửa); dòng giữ nguyên không đụng tới (giữ người/lúc tạo).
 */
export async function syncEntryAttachments(
  tx: AttachmentDb,
  entryId: number,
  desired: DesiredAttachment[],
  actorId: number,
): Promise<{
  added: InternalFinanceAttachment[];
  removed: InternalFinanceAttachment[];
  kept: InternalFinanceAttachment[];
}> {
  const wanted = new Map<string, DesiredAttachment>();
  for (const file of desired || []) {
    if (!file?.fileUrl) continue;
    const key = attachmentKey(file);
    if (!wanted.has(key)) wanted.set(key, file);
  }
  const current = await tx.internalFinanceAttachment.findMany({
    where: { entryId, ...ACTIVE_ROW },
    orderBy: { id: 'asc' },
  });
  const kept: InternalFinanceAttachment[] = [];
  const removed: InternalFinanceAttachment[] = [];
  const matched = new Set<string>();
  for (const row of current) {
    const key = attachmentKey(row);
    if (wanted.has(key) && !matched.has(key)) {
      matched.add(key);
      kept.push(row);
    } else {
      removed.push(row);
    }
  }
  const toCreate = [...wanted.entries()]
    .filter(([key]) => !matched.has(key))
    .map(([, file]) => file);

  const now = new Date();
  if (removed.length) {
    await tx.internalFinanceAttachment.updateMany({
      where: { id: { in: removed.map((row) => row.id) }, ...ACTIVE_ROW },
      data: { removedAt: now, removedBy: actorId },
    });
  }
  let added: InternalFinanceAttachment[] = [];
  if (toCreate.length) {
    await tx.internalFinanceAttachment.createMany({
      data: toCreate.map((file) => ({
        entryId,
        kind: file.kind || DEFAULT_KIND,
        fileUrl: file.fileUrl,
        fileName: file.fileName ?? null,
        fileType: file.fileType ?? null,
        fileSize: file.fileSize ?? null,
        createdBy: actorId,
      })),
    });
    const keptIds = new Set(kept.map((row) => row.id));
    added = (
      await tx.internalFinanceAttachment.findMany({
        where: { entryId, ...ACTIVE_ROW },
        orderBy: { id: 'asc' },
      })
    ).filter((row) => !keptIds.has(row.id));
  }
  return {
    added,
    removed: removed.map((row) => ({
      ...row,
      removedAt: now,
      removedBy: actorId,
    })),
    kept,
  };
}

function sameAmount(
  current: Prisma.Decimal | null,
  next: DesiredInvoiceLink['amount'],
) {
  if (next === null || next === undefined || next === '')
    return current === null;
  if (current === null) return false;
  return current.equals(new Prisma.Decimal(String(next)));
}

function amountValue(amount: DesiredInvoiceLink['amount']) {
  return amount === null || amount === undefined || amount === ''
    ? null
    : new Prisma.Decimal(String(amount));
}

/**
 * Đồng bộ liên kết hóa đơn của phiếu (giữ @@unique([entryId, invoiceId])):
 * bỏ khỏi danh sách → gỡ (removedAt); thêm lại hóa đơn đã gỡ → khôi phục dòng
 * cũ; hóa đơn mới → tạo. Số tiền chỉ cập nhật khi được truyền và khác.
 */
export async function syncEntryInvoiceLinks(
  tx: InvoiceLinkDb,
  entryId: number,
  desired: DesiredInvoiceLink[],
  actorId: number,
): Promise<{
  added: InternalFinanceInvoiceLink[];
  revived: InternalFinanceInvoiceLink[];
  removed: InternalFinanceInvoiceLink[];
  kept: InternalFinanceInvoiceLink[];
}> {
  const wanted = new Map<number, DesiredInvoiceLink>();
  for (const link of desired || []) {
    const invoiceId = Number(link?.invoiceId);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) continue;
    if (!wanted.has(invoiceId)) wanted.set(invoiceId, { ...link, invoiceId });
  }
  // Đọc cả dòng đã gỡ để khôi phục thay vì vướng khóa unique.
  const rows = await tx.internalFinanceInvoiceLink.findMany({
    where: { entryId },
    orderBy: { id: 'asc' },
  });
  const byInvoice = new Map(rows.map((row) => [row.invoiceId, row]));
  const now = new Date();
  const added: InternalFinanceInvoiceLink[] = [];
  const revived: InternalFinanceInvoiceLink[] = [];
  const removed: InternalFinanceInvoiceLink[] = [];
  const kept: InternalFinanceInvoiceLink[] = [];

  const removeIds = rows
    .filter((row) => row.removedAt === null && !wanted.has(row.invoiceId))
    .map((row) => row.id);
  if (removeIds.length) {
    await tx.internalFinanceInvoiceLink.updateMany({
      where: { id: { in: removeIds }, ...ACTIVE_ROW },
      data: { removedAt: now, removedBy: actorId },
    });
    for (const row of rows)
      if (removeIds.includes(row.id))
        removed.push({ ...row, removedAt: now, removedBy: actorId });
  }

  for (const [invoiceId, link] of wanted) {
    const row = byInvoice.get(invoiceId);
    if (!row) {
      added.push(
        await tx.internalFinanceInvoiceLink.create({
          data: { entryId, invoiceId, amount: amountValue(link.amount) },
        }),
      );
      continue;
    }
    if (row.removedAt !== null) {
      revived.push(
        await tx.internalFinanceInvoiceLink.update({
          where: { id: row.id },
          data: {
            removedAt: null,
            removedBy: null,
            ...(link.amount !== undefined
              ? { amount: amountValue(link.amount) }
              : {}),
          },
        }),
      );
      continue;
    }
    if (link.amount !== undefined && !sameAmount(row.amount, link.amount)) {
      kept.push(
        await tx.internalFinanceInvoiceLink.update({
          where: { id: row.id },
          data: { amount: amountValue(link.amount) },
        }),
      );
      continue;
    }
    kept.push(row);
  }
  return { added, revived, removed, kept };
}
