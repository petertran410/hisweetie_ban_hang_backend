import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { INVOICE_STATUS } from '../invoices/dto';

export type PackingInvoiceRef = {
  id: number;
  code: string;
  status: number;
};

const INVOICE_CODE = /^HD(\d{6})(?:\.(\d+))?$/;

export function invoiceVersion(
  code: string,
): { base: string; suffix: number } | null {
  const match = INVOICE_CODE.exec(code);
  if (!match) return null;
  return {
    base: `HD${match[1]}`,
    suffix: match[2] ? Number(match[2]) : 0,
  };
}

/**
 * Hóa đơn chưa hủy giữ nguyên. Hóa đơn đã hủy chuyển sang bản cùng gốc
 * HD###### có hậu tố lớn nhất và còn hiệu lực. Không có bản đó thì từ chối.
 */
export function pickLivePackingInvoice<T extends PackingInvoiceRef>(
  invoice: T,
  family: T[],
): T {
  if (invoice.status !== INVOICE_STATUS.CANCELLED) return invoice;

  const version = invoiceVersion(invoice.code);
  const live = version
    ? family
        .filter((item) => item.status !== INVOICE_STATUS.CANCELLED)
        .map((item) => ({ item, version: invoiceVersion(item.code) }))
        .filter((entry) => entry.version?.base === version.base)
        .sort(
          (a, b) =>
            b.version!.suffix - a.version!.suffix || b.item.id - a.item.id,
        )[0]?.item
    : undefined;

  if (!live) {
    throw new BadRequestException(
      `Hóa đơn ${invoice.code} đã hủy, không thể báo đơn`,
    );
  }
  return live;
}

export function collapsePackingInvoiceTargets<T extends PackingInvoiceRef>(
  invoices: T[],
  family: T[],
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const invoice of invoices) {
    const target = pickLivePackingInvoice(invoice, family);
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  return ids;
}

/**
 * Khóa các hóa đơn được gửi lên, rồi đổi id hóa đơn đã hủy sang bản còn
 * hiệu lực trước khi ghi liên kết phiếu.
 */
export async function resolveActivePackingInvoiceIds(
  tx: any,
  invoiceIds: number[],
): Promise<number[]> {
  const orderedIds: number[] = [];
  const seen = new Set<number>();
  for (const id of invoiceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }
  if (orderedIds.length === 0) return [];

  await tx.$queryRaw`
    SELECT id FROM invoices
    WHERE id IN (${Prisma.join(orderedIds)})
    FOR UPDATE
  `;

  const selected = await tx.invoice.findMany({
    where: { id: { in: orderedIds } },
    select: { id: true, code: true, status: true },
  });
  if (selected.length !== orderedIds.length) {
    throw new BadRequestException('Không tìm thấy hóa đơn');
  }

  const byId = new Map<number, PackingInvoiceRef>(
    selected.map((invoice: PackingInvoiceRef) => [invoice.id, invoice]),
  );
  const cancelled = orderedIds
    .map((id) => byId.get(id)!)
    .filter((invoice) => invoice.status === INVOICE_STATUS.CANCELLED);

  let family: PackingInvoiceRef[] = selected;
  if (cancelled.length > 0) {
    const bases = [
      ...new Set(
        cancelled
          .map((invoice) => invoiceVersion(invoice.code)?.base)
          .filter((base): base is string => !!base),
      ),
    ];
    if (bases.length > 0) {
      await tx.$queryRaw`
        SELECT id FROM invoices
        WHERE substring(code from '^(HD[0-9]{6})') IN (${Prisma.join(bases)})
          AND code ~ '^HD[0-9]{6}(\\.[0-9]+)?$'
        FOR UPDATE
      `;
      family = await tx.invoice.findMany({
        where: {
          OR: bases.flatMap((base) => [
            { code: base },
            { code: { startsWith: `${base}.` } },
          ]),
        },
        select: { id: true, code: true, status: true },
      });
    }
  }

  return collapsePackingInvoiceTargets(
    orderedIds.map((id) => byId.get(id)!),
    family,
  );
}
