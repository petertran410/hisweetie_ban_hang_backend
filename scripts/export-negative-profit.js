// One-shot: export hóa đơn lợi nhuận âm (profit < 0) ra CSV.
// profit = grandTotal - COGS ; COGS = SUM(qty * inventories.cost) join productId+branchId
// Usage: node scripts/export-negative-profit.js <fromISO> <toISO> [outFile]
const { PrismaClient } = require('@prisma/client');

const fromArg = process.argv[2] || '2026-06-01T00:00:00+07:00';
const toArg = process.argv[3] || '2026-07-01T00:00:00+07:00';
const outFile = process.argv[4] || '/tmp/negative-profit.csv';

const prisma = new PrismaClient();

function pad(n) {
  return String(n).padStart(2, '0');
}
// format dd/MM/yyyy HH:mm theo giờ VN (GMT+7)
function fmtDate(d) {
  const t = new Date(new Date(d).getTime() + 7 * 3600 * 1000);
  return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      i.id, i.code, i."purchaseDate" AS purchase_date,
      u.name AS sold_by, c.name AS customer, b.name AS branch,
      i."grandTotal"::float8 AS revenue,
      COALESCE(li.cogs,0)::float8 AS cost,
      (i."grandTotal" - COALESCE(li.cogs,0))::float8 AS profit
    FROM invoices i
    LEFT JOIN LATERAL (
      SELECT SUM(d.quantity * COALESCE(inv.cost,0)) AS cogs
      FROM invoice_details d
      LEFT JOIN inventories inv
        ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
      WHERE d."invoiceId" = i.id
    ) li ON true
    LEFT JOIN users u     ON u.id = i."soldById"
    LEFT JOIN customers c ON c.id = i."customerId"
    LEFT JOIN branches b  ON b.id = i."branchId"
    WHERE i."purchaseDate" >= $1::timestamptz
      AND i."purchaseDate" <  $2::timestamptz
      AND (i."grandTotal" - COALESCE(li.cogs,0)) < 0
    ORDER BY profit ASC
    `,
    fromArg,
    toArg,
  );

  const header = [
    'Mã HĐ',
    'Ngày',
    'NV bán',
    'Khách',
    'Chi nhánh',
    'Doanh thu',
    'Giá vốn',
    'Lợi nhuận',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.code),
        csvCell(fmtDate(r.purchase_date)),
        csvCell(r.sold_by),
        csvCell(r.customer || 'Khách lẻ'),
        csvCell(r.branch),
        csvCell(Math.round(r.revenue)),
        csvCell(Math.round(r.cost)),
        csvCell(Math.round(r.profit)),
      ].join(','),
    );
  }

  require('fs').writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`rows=${rows.length} out=${outFile}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
