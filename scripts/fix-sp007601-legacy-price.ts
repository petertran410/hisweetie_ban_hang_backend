/**
 * SỬA DỮ LIỆU 1 LẦN — dòng SP007601 của hóa đơn CŨ bị POS bóc 8% sai công thức.
 *
 * POS từng giảm giá dòng chứng từ cũ bằng "giá × 0,92". Đúng phải là bóc VAT 8%:
 * "giá ÷ 1,08" (120,000 → 111,111.11; chọn GTGT 5% → 116,666.67). Script tìm các
 * dòng đã lưu theo công thức cũ và sửa THẲNG trên hóa đơn hiện tại (giữ mã, không
 * tạo bản .xx, không động kho/thanh toán, không gửi Zalo/Lark phiếu giao), rồi tính
 * lại công nợ khách bằng recalcCustomerDebt — đúng hàm app đang dùng.
 *
 * Chạy từ hisweetie_ban_hang_backend:
 *   npx ts-node scripts/fix-sp007601-legacy-price.ts             # dry-run: chặn mọi lệnh ghi
 *   npx ts-node scripts/fix-sp007601-legacy-price.ts --apply     # GHI DB
 *   thêm --out <file.csv> để đổi chỗ lưu báo cáo (mặc định ./fix-sp007601-<mode>-<giờ>.csv)
 *
 * Chạy lại an toàn: dòng đã đúng công thức ÷ 1,08 được đếm là "đã đúng", không sửa nữa.
 *
 * Cách nhận dòng sai (SP007601, line_vat_rate có số, hóa đơn chưa hủy, purchaseDate
 * trước mốc đổi giá 2026-11-27 18:00 UTC = chứng từ cũ):
 *  1. ancestor    : bản trước gần nhất (cùng mã gốc trước dấu ".") có dòng SP007601
 *                   NULL cho giá gốc P0/D0, và giá hiện tại = round(P0 × 0,92) × (1 + GTGT).
 *  2. reverse_base: không khớp bản trước, nhưng giá / (1 + GTGT) / 0,92 ra số chẵn nghìn
 *                   (vd đã đổi bảng giá hoặc bỏ giảm giá trước khi lưu) → sửa theo số đó.
 *  3. already_ok  : đã đúng công thức ÷ 1,08 → bỏ qua.
 *  4. skip        : không nhận ra → liệt kê để sửa tay.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { recalcCustomerDebt } from '../src/common/customer-debt.util';
import { roundMoney } from '../src/common/money.util';
import { LINE_VAT_PRODUCT_CODES } from '../src/misa-sync/misa-vat.util';
import {
  INVOICE_STATUS,
  INVOICE_STATUS_LABELS,
} from '../src/invoices/dto/invoice-status.constants';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

/** Mốc đổi bảng giá SP007601 (UTC) — chứng từ có purchaseDate trước mốc là chứng từ cũ. */
const LEGACY_CUTOFF = new Date('2026-11-27T18:00:00Z');
const OLD_FACTOR = 0.92; // công thức SAI đã dùng
const VAT_DIVISOR = 1.08; // công thức ĐÚNG

const APPLY = process.argv.includes('--apply');
const outArg = process.argv.indexOf('--out');
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '-')
  .slice(0, 15);
const OUT_FILE =
  outArg > 0 && process.argv[outArg + 1]
    ? path.resolve(process.argv[outArg + 1])
    : path.resolve(`fix-sp007601-${APPLY ? 'apply' : 'dry'}-${stamp}.csv`);

const round2 = roundMoney; // tiền giữ tối đa 2 số lẻ, giống POS
const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;
const dec = (n: number) => new Prisma.Decimal(round2(n).toFixed(2));

/** Giá đã lưu theo công thức SAI từ giá gốc (đã gồm 8%). */
const oldFormula = (base: number, rate: number) =>
  round2(Math.round(base * OLD_FACTOR) * (1 + rate / 100));
/** Giá đúng: bóc 8% (÷ 1,08, làm tròn 2 số lẻ) rồi cộng GTGT dòng — y hệt POS mới. */
const newFormula = (base: number, rate: number) =>
  round2(round2(base / VAT_DIVISOR) * (1 + rate / 100));

/** Suy ngược giá gốc từ giá đã lưu theo công thức sai; null nếu không khớp. */
const reverseOld = (saved: number, rate: number, step: number) => {
  const base = Math.round(saved / (1 + rate / 100) / OLD_FACTOR);
  return base % step === 0 && eq(oldFormula(base, rate), saved) ? base : null;
};
const reverseNew = (saved: number, rate: number, step: number) => {
  const base = Math.round((saved / (1 + rate / 100)) * VAT_DIVISOR);
  return base % step === 0 && eq(newFormula(base, rate), saved) ? base : null;
};

type Kind = 'ancestor' | 'reverse_base' | 'already_ok' | 'skip';

interface Row {
  invoiceId: number;
  code: string;
  customerId: number | null;
  customerCode: string | null;
  status: number;
  totalAmount: number;
  discount: number;
  discountRatio: number;
  grandTotal: number;
  paidAmount: number;
  debtAmount: number;
  misa: string;
  detailId: number;
  price: number;
  lineDiscount: number;
  quantity: number;
  totalPrice: number;
  rate: number;
  srcCode: string | null;
  /** [giá, giảm giá] mọi dòng SP này (NULL) của bản trước — HĐ có thể có >1 dòng. */
  srcLines: [number, number][];
}

interface LineFix extends Row {
  kind: Kind;
  basePrice: number | null;
  baseDiscount: number | null;
  newPrice: number;
  newDiscount: number;
  newTotalPrice: number;
}

interface InvoiceFix {
  invoiceId: number;
  code: string;
  customerId: number | null;
  lines: LineFix[];
  delta: number;
  old: Pick<
    Row,
    'status' | 'totalAmount' | 'discount' | 'grandTotal' | 'debtAmount'
  >;
  next: Pick<
    Row,
    'status' | 'totalAmount' | 'discount' | 'grandTotal' | 'debtAmount'
  >;
}

function classify(row: Row): LineFix {
  const { rate, price, lineDiscount } = row;
  const base = (
    kind: Kind,
    basePrice: number | null,
    baseDiscount: number | null,
  ): LineFix => {
    const fix = kind === 'ancestor' || kind === 'reverse_base';
    const newPrice = fix ? newFormula(basePrice!, rate) : price;
    const newDiscount = fix ? newFormula(baseDiscount!, rate) : lineDiscount;
    return {
      ...row,
      kind,
      basePrice,
      baseDiscount,
      newPrice,
      newDiscount,
      newTotalPrice: fix
        ? round2(round2(newPrice - newDiscount) * row.quantity)
        : row.totalPrice,
    };
  };

  // Dòng không có mã dòng ổn định giữa các bản → so với TỪNG dòng của bản trước.
  const fromOld = row.srcLines.find(
    ([p, d]) =>
      eq(price, oldFormula(p, rate)) && eq(lineDiscount, oldFormula(d, rate)),
  );
  if (fromOld) return base('ancestor', fromOld[0], fromOld[1]);
  const fromNew = row.srcLines.find(
    ([p, d]) =>
      eq(price, newFormula(p, rate)) && eq(lineDiscount, newFormula(d, rate)),
  );
  if (fromNew) return base('already_ok', fromNew[0], fromNew[1]);
  const bp = reverseOld(price, rate, 1000);
  const bd = reverseOld(lineDiscount, rate, 1);
  if (bp != null && bd != null) return base('reverse_base', bp, bd);
  const np = reverseNew(price, rate, 1000);
  const nd = reverseNew(lineDiscount, rate, 1);
  if (np != null && nd != null) return base('already_ok', np, nd);
  return base('skip', null, null);
}

function buildInvoiceFix(lines: LineFix[]): InvoiceFix {
  const h = lines[0];
  const delta = round2(
    lines.reduce((s, l) => s + (l.newTotalPrice - l.totalPrice), 0),
  );
  // Giảm giá toàn đơn theo %: phần giảm tăng theo tổng tiền hàng (vd 100% → khách
  // vẫn trả 0). Giảm theo số tiền cố định thì giữ nguyên.
  const deltaDiscount =
    h.discountRatio > 0 ? round2((delta * h.discountRatio) / 100) : 0;
  const grandTotal = round2(h.grandTotal + delta - deltaDiscount);
  // Toàn bộ HĐ bị ảnh hưởng đang có debtAmount = grandTotal − paidAmount (âm khi
  // khách trả dư) — giữ đúng quy ước luồng sửa hóa đơn.
  const debtAmount = round2(grandTotal - h.paidAmount);
  // Như luồng sửa hóa đơn: Hoàn thành mà còn nợ → Giao thành công.
  const status =
    h.status === INVOICE_STATUS.COMPLETED && debtAmount > 0
      ? INVOICE_STATUS.DELIVERED
      : h.status;
  return {
    invoiceId: h.invoiceId,
    code: h.code,
    customerId: h.customerId,
    lines,
    delta,
    old: {
      status: h.status,
      totalAmount: h.totalAmount,
      discount: h.discount,
      grandTotal: h.grandTotal,
      debtAmount: h.debtAmount,
    },
    next: {
      status,
      totalAmount: round2(h.totalAmount + delta),
      discount: round2(h.discount + deltaDiscount),
      grandTotal,
      debtAmount,
    },
  };
}

async function loadRows(prisma: PrismaClient): Promise<Row[]> {
  const raw: any[] = await prisma.$queryRaw(Prisma.sql`
    SELECT i.id AS "invoiceId", i.code, i."customerId", c.code AS "customerCode", i.status,
           i."totalAmount", i.discount, i."discountRatio", i."grandTotal", i."paidAmount",
           i."debtAmount", i."misaSyncStatus"::text AS misa,
           d.id AS "detailId", d.price, d.discount AS "lineDiscount", d.quantity,
           d."totalPrice", d.line_vat_rate AS rate,
           src.code AS "srcCode", src.lines AS "srcLines"
    FROM invoices i
    JOIN invoice_details d ON d."invoiceId" = i.id
    LEFT JOIN customers c ON c.id = i."customerId"
    LEFT JOIN LATERAL (
      SELECT pi.code,
             json_agg(json_build_array(pd.price, pd.discount) ORDER BY pd.id) AS lines
      FROM invoices pi
      JOIN invoice_details pd ON pd."invoiceId" = pi.id
      WHERE split_part(pi.code, '.', 1) = split_part(i.code, '.', 1)
        AND pi.code < i.code
        AND pd."productCode" = d."productCode"
        AND pd.line_vat_rate IS NULL
      GROUP BY pi.code
      ORDER BY pi.code DESC
      LIMIT 1
    ) src ON true
    WHERE d."productCode" IN (${Prisma.join(LINE_VAT_PRODUCT_CODES)})
      AND d.line_vat_rate IS NOT NULL
      AND i.status <> ${INVOICE_STATUS.CANCELLED}
      AND i."purchaseDate" < ${LEGACY_CUTOFF}
    ORDER BY i."customerId" NULLS LAST, i.id, d.id
  `);
  return raw.map((r) => ({
    invoiceId: r.invoiceId,
    code: r.code,
    customerId: r.customerId,
    customerCode: r.customerCode,
    status: r.status,
    totalAmount: Number(r.totalAmount),
    discount: Number(r.discount),
    discountRatio: Number(r.discountRatio),
    grandTotal: Number(r.grandTotal),
    paidAmount: Number(r.paidAmount),
    debtAmount: Number(r.debtAmount),
    misa: r.misa,
    detailId: r.detailId,
    price: Number(r.price),
    lineDiscount: Number(r.lineDiscount),
    quantity: Number(r.quantity),
    totalPrice: Number(r.totalPrice),
    rate: Number(r.rate),
    srcCode: r.srcCode,
    srcLines: ((r.srcLines ?? []) as unknown[][]).map(
      ([p, d]) => [Number(p), Number(d)] as [number, number],
    ),
  }));
}

function writeCsv(lines: LineFix[], fixes: Map<number, InvoiceFix>) {
  const cols = [
    'invoiceCode',
    'customerCode',
    'kind',
    'vatRate',
    'srcCode',
    'basePrice',
    'baseDiscount',
    'oldPrice',
    'oldDiscount',
    'newPrice',
    'newDiscount',
    'quantity',
    'oldLineTotal',
    'newLineTotal',
    'oldGrandTotal',
    'newGrandTotal',
    'paidAmount',
    'oldDebtAmount',
    'newDebtAmount',
    'oldStatus',
    'newStatus',
    'misa',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = lines.map((l) => {
    const f = fixes.get(l.invoiceId);
    return [
      l.code,
      l.customerCode,
      l.kind,
      l.rate,
      l.srcCode,
      l.basePrice,
      l.baseDiscount,
      l.price,
      l.lineDiscount,
      l.newPrice,
      l.newDiscount,
      l.quantity,
      l.totalPrice,
      l.newTotalPrice,
      l.grandTotal,
      f?.next.grandTotal ?? l.grandTotal,
      l.paidAmount,
      l.debtAmount,
      f?.next.debtAmount ?? l.debtAmount,
      l.status,
      f?.next.status ?? l.status,
      l.misa,
    ]
      .map(esc)
      .join(',');
  });
  fs.writeFileSync(OUT_FILE, '﻿' + [cols.join(','), ...rows].join('\n'));
}

/** Ghi 1 khách: khóa + đọc lại từng HĐ, bỏ HĐ nào đã đổi kể từ lúc tính, rồi tính lại công nợ. */
async function applyCustomer(
  prisma: PrismaClient,
  customerId: number | null,
  invoices: InvoiceFix[],
): Promise<{ applied: string[]; changed: string[] }> {
  const applied: string[] = [];
  const changed: string[] = [];
  await prisma.$transaction(
    // tx: any — schema rất lớn, kiểu Prisma suy ra vượt giới hạn của tsc.
    async (tx: any) => {
      for (const inv of invoices) {
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${inv.invoiceId} FOR UPDATE`;
        const fresh = await tx.invoice.findUnique({
          where: { id: inv.invoiceId },
          select: {
            status: true,
            totalAmount: true,
            discount: true,
            grandTotal: true,
            debtAmount: true,
            details: {
              where: { id: { in: inv.lines.map((l) => l.detailId) } },
              select: {
                id: true,
                price: true,
                discount: true,
                totalPrice: true,
                quantity: true,
              },
            },
          },
        });
        const unchanged =
          !!fresh &&
          fresh.status === inv.old.status &&
          eq(Number(fresh.totalAmount), inv.old.totalAmount) &&
          eq(Number(fresh.discount), inv.old.discount) &&
          eq(Number(fresh.grandTotal), inv.old.grandTotal) &&
          eq(Number(fresh.debtAmount), inv.old.debtAmount) &&
          fresh.details.length === inv.lines.length &&
          inv.lines.every((l) => {
            const d = fresh.details.find((x: any) => x.id === l.detailId);
            return (
              !!d &&
              eq(Number(d.price), l.price) &&
              eq(Number(d.discount), l.lineDiscount) &&
              eq(Number(d.totalPrice), l.totalPrice) &&
              eq(Number(d.quantity), l.quantity)
            );
          });
        if (!unchanged) {
          changed.push(inv.code);
          continue;
        }
        for (const l of inv.lines) {
          await tx.invoiceDetail.update({
            where: { id: l.detailId },
            data: {
              price: dec(l.newPrice),
              discount: dec(l.newDiscount),
              totalPrice: dec(l.newTotalPrice),
            },
          });
        }
        await tx.invoice.update({
          where: { id: inv.invoiceId },
          data: {
            totalAmount: dec(inv.next.totalAmount),
            discount: dec(inv.next.discount),
            grandTotal: dec(inv.next.grandTotal),
            debtAmount: dec(inv.next.debtAmount),
            status: inv.next.status,
            statusValue: INVOICE_STATUS_LABELS[inv.next.status],
          },
        });
        applied.push(inv.code);
      }
      if (customerId != null && applied.length > 0) {
        await recalcCustomerDebt(tx, customerId, { syncTotalPurchased: true });
      }
    },
    { timeout: 120_000 },
  );
  return { applied, changed };
}

async function main() {
  const host =
    (process.env.DATABASE_URL ?? '').split('@').pop()?.split(/[:/]/)[0] ?? '';
  const dbKind = ['localhost', '127.0.0.1', '::1'].includes(host)
    ? 'LOCAL'
    : 'REMOTE';
  console.log(
    `DB: ${dbKind} | chế độ: ${APPLY ? 'APPLY (ghi DB)' : 'DRY-RUN (chặn ghi)'}`,
  );

  const base = new PrismaClient();
  // Dry-run: chặn mọi thao tác ghi ở tầng client, phòng khi code đổi sau này.
  const READS = new Set([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
  ]);
  const prisma = (APPLY
    ? base
    : base.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }: any) {
              if (!READS.has(operation))
                throw new Error(`DRY-RUN chặn ghi ${model}.${operation}`);
              return query(args);
            },
          },
        },
      })) as unknown as PrismaClient;

  try {
    const lines = (await loadRows(prisma)).map(classify);
    const byInvoice = new Map<number, LineFix[]>();
    for (const l of lines) {
      if (l.kind !== 'ancestor' && l.kind !== 'reverse_base') continue;
      byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
    }
    const fixes = new Map<number, InvoiceFix>();
    for (const [id, ls] of byInvoice) fixes.set(id, buildInvoiceFix(ls));

    const count = (k: Kind) => lines.filter((l) => l.kind === k).length;
    const list = [...fixes.values()];
    const customers = new Set(list.map((f) => f.customerId));
    const codesOf = (k: Kind) => [
      ...new Set(lines.filter((l) => l.kind === k).map((l) => l.code)),
    ];
    console.log(
      `Dòng SP007601 xét: ${lines.length} | sai công thức (bản trước): ${count('ancestor')} | ` +
        `sai công thức (suy ngược giá gốc): ${count('reverse_base')} | đã đúng: ${count('already_ok')} | ` +
        `không nhận ra: ${count('skip')}`,
    );
    console.log(
      `Hóa đơn cần sửa: ${list.length} | khách: ${customers.size} | ` +
        `tổng tiền khách phải trả tăng: ${round2(list.reduce((s, f) => s + f.next.grandTotal - f.old.grandTotal, 0)).toLocaleString('en-US')}đ | ` +
        `Hoàn thành → Giao thành công: ${list.filter((f) => f.next.status !== f.old.status).length}`,
    );
    const synced = list.filter((f) => f.lines[0].misa === 'SYNCED');
    if (synced.length)
      console.log(
        `Đã đẩy MISA, cần đẩy lại sau khi sửa: ${synced.map((f) => f.code).join(', ')}`,
      );
    if (codesOf('reverse_base').length)
      console.log(
        `Suy ngược giá gốc (xem kỹ trong CSV): ${codesOf('reverse_base').join(', ')}`,
      );
    if (codesOf('skip').length)
      console.log(`Không nhận ra — sửa tay: ${codesOf('skip').join(', ')}`);

    writeCsv(lines, fixes);
    console.log(`Báo cáo: ${OUT_FILE}`);

    if (!APPLY) {
      console.log('DRY-RUN: chưa ghi gì. Thêm --apply để sửa.');
      return;
    }

    const groups = new Map<number | null, InvoiceFix[]>();
    for (const f of list)
      groups.set(f.customerId, [...(groups.get(f.customerId) ?? []), f]);
    const applied: string[] = [];
    const changed: string[] = [];
    for (const [customerId, invoices] of groups) {
      const r = await applyCustomer(base, customerId, invoices);
      applied.push(...r.applied);
      changed.push(...r.changed);
    }
    console.log(
      `ĐÃ SỬA ${applied.length} hóa đơn, tính lại công nợ ${groups.size} khách.`,
    );
    if (changed.length)
      console.log(
        `Bỏ qua vì hóa đơn đã đổi trong lúc chạy (chạy lại script): ${changed.join(', ')}`,
      );
  } finally {
    await base.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
