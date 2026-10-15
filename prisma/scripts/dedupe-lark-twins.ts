// prisma/scripts/dedupe-lark-twins.ts
//
// Gộp một lần các phiếu chi bị nhập đôi từ LarkBase: bản sao ở bảng "Tổng hợp
// phiếu chi kho" của phiếu xe (Xăng dầu / Chăm sóc xe) và của cước báo đơn.
// Xem src/internal-finance/lark-twin-dedupe.ts. Chỉ đọc DB khi chạy thử.
//
// Cách chạy:
//   yarn dedupe:lark-twins                     # chạy thử, không ghi
//   yarn dedupe:lark-twins --apply --user=<id> # ghi thật

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { HN, SG } from '../../src/internal-finance/legacy-fund-reconcile';
import {
  applyTwinDedupe,
  fundBalance,
  planTwinDedupe,
  refundByBranch,
  vnDay,
  type TwinPlan,
  type TwinRow,
} from '../../src/internal-finance/lark-twin-dedupe';

const NAME: Record<number, string> = { [HN]: 'Kho HN', [SG]: 'Kho SG' };
const ACTION_LABEL: Record<string, string> = {
  moveBatch: 'chuyển tuần Approval sang phiếu giữ lại',
  detachSameBatch: 'cả hai cùng tuần: gỡ bản sao khỏi tuần',
  moveCash: 'chuyển Đã chi (và giao dịch quỹ) sang phiếu giữ lại',
  cancelDoubleFund: 'TRỪ QUỸ HAI LẦN: hủy giao dịch quỹ của bản sao',
};

const BASIS_LABEL = {
  label: 'tên xe',
  item: 'khoản mục xe',
  note: 'ghi chú',
} as const;

const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
const line = (row: TwinRow) =>
  `${vnDay(row.occurredAt)}  ${row.code}  ${money(row.amount)}đ  ${row.description || ''}`;

function report(plan: TwinPlan, before: Map<number, unknown>) {
  const refund = refundByBranch(plan);
  for (const branchId of [HN, SG]) {
    const merges = plan.merges.filter((m) => m.dup.branchId === branchId);
    console.log(`\n===== ${NAME[branchId]} =====`);
    for (const kind of ['vehicle', 'packing'] as const) {
      const list = merges.filter((m) => m.kind === kind);
      const total = list.reduce((s, m) => s + Number(m.dup.amount), 0);
      console.log(
        `${kind === 'vehicle' ? 'Cặp phiếu xe' : 'Cặp cước báo đơn'} sẽ gộp: ${list.length} cặp, ${money(total)}đ`,
      );
      if (kind === 'vehicle' && list.length)
        console.log(
          `  ghép theo: ${(['label', 'item', 'note'] as const)
            .map(
              (basis) =>
                `${BASIS_LABEL[basis]} ${list.filter((m) => m.basis === basis).length}`,
            )
            .join(', ')}`,
        );
      for (const m of list.slice(0, 30))
        console.log(
          `  hủy  ${line(m.dup)}\n  giữ  ${line(m.keep)}${
            m.basis ? `  [${BASIS_LABEL[m.basis]}]` : ''
          }\n`,
        );
    }
    for (const action of Object.keys(ACTION_LABEL)) {
      const list = merges.filter((m) => m.actions.includes(action as any));
      if (!list.length) continue;
      console.log(`- ${ACTION_LABEL[action]}: ${list.length} cặp`);
      if (action === 'cancelDoubleFund' || action === 'detachSameBatch')
        for (const m of list)
          console.log(
            `    ${m.dup.code} → ${m.keep.code}  ${money(m.dup.amount)}đ  tuần ${m.dup.weeklyBatch?.code || '-'} (${m.dup.weeklyBatch?.status || '-'})`,
          );
    }
    const now = Number(before.get(branchId) || 0);
    console.log(
      `Số dư quỹ hiện tại: ${money(now)} → ${money(now + refund.get(branchId)!)} (cộng lại ${money(refund.get(branchId))})`,
    );
  }

  const show = (
    title: string,
    rows: Array<{ dup: TwinRow; extra: string }>,
  ) => {
    if (!rows.length) return;
    console.log(`\n${title}: ${rows.length}`);
    for (const row of rows.slice(0, 50))
      console.log(`  ${line(row.dup)}  — ${row.extra}`);
  };
  show(
    'Không tự gộp (cần kiểm tay)',
    plan.skipped.map((s) => ({
      dup: s.dup,
      extra: `${s.keep.code}: ${s.reason}`,
    })),
  );
  show(
    'Khớp nhiều phiếu xe (cần kiểm tay)',
    plan.ambiguous.map((a) => ({
      dup: a.dup,
      extra: a.keeps.map((k) => k.code).join(', '),
    })),
  );
  show(
    'Cước báo đơn lệch số tiền (cần kiểm tay)',
    plan.packingMismatched.map((m) => ({
      dup: m.dup,
      extra: `${m.keep.code} ${money(m.keep.amount)}đ`,
    })),
  );

  if (plan.suspects.length) {
    console.log(
      `\nNghi trùng khác (chỉ xem, KHÔNG tự gộp): ${plan.suspects.length} nhóm cùng kho, cùng ngày, cùng số tiền`,
    );
    for (const group of plan.suspects.slice(0, 100)) {
      console.log(
        `  ${NAME[group[0].branchId]}  ${vnDay(group[0].occurredAt)}  ${money(group[0].amount)}đ`,
      );
      for (const row of group)
        console.log(
          `    ${row.code}  [${row.sourceType}/${row.category}]  ${row.description || ''}${
            row.note ? `  | ghi chú: ${row.note}` : ''
          }${row.payer?.name ? `  | người chi: ${row.payer.name}` : ''}`,
        );
    }
    if (plan.suspects.length > 100)
      console.log(`  … còn ${plan.suspects.length - 100} nhóm`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userArg = process.argv.find((arg) => arg.startsWith('--user='));
  const userId = userArg ? Number(userArg.split('=')[1]) : NaN;
  if (apply && !Number.isInteger(userId))
    throw new Error('Cần --user=<id> khi chạy --apply');

  const prisma = new PrismaClient();
  try {
    const before = await fundBalance(prisma);
    const plan = apply
      ? await applyTwinDedupe(prisma, userId)
      : await planTwinDedupe(prisma);
    console.log(apply ? '✅ ĐÃ GHI THẬT' : '🔎 CHẠY THỬ (không ghi DB)');
    report(plan, before);
    if (apply) {
      const after = await fundBalance(prisma);
      for (const id of [HN, SG])
        console.log(`${NAME[id]} số dư sau khi ghi: ${money(after.get(id))}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌', error);
  process.exit(1);
});
