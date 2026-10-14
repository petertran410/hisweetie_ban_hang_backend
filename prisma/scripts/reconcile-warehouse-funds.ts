// prisma/scripts/reconcile-warehouse-funds.ts
//
// Đối soát một lần quỹ Kho HN / Kho SG với sổ quỹ LarkBase (đúng đến hết
// 10/10/2026). Xem src/internal-finance/legacy-fund-reconcile.ts.
// Chỉ ĐỌC LarkBase. Mặc định chạy thử (in báo cáo, không ghi DB).
//
// Cách chạy:
//   yarn reconcile:warehouse-funds                     # chạy thử
//   yarn reconcile:warehouse-funds --apply --user=<id> # ghi thật

import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { PrismaClient } from '@prisma/client';
import {
  CUTOFF,
  HN,
  SG,
  applyReconcile,
  balanceDelta,
  fundBalance,
  planReconcile,
  type LarkRecord,
  type ReconcilePlan,
} from '../../src/internal-finance/legacy-fund-reconcile';

const LEDGER_TABLE = process.env.LARK_FUND_LEDGER_TABLE || 'tblltz1Zcxe479UG';
// "Cuối Kì Lark" ngày 10/10 trên bảng "Chốt Sổ Kho Hàng Ngày".
const LARK_CLOSING_1010 = { [HN]: 199274440, [SG]: 52562077 };
const NAME = { [HN]: 'Kho HN', [SG]: 'Kho SG' };

const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

async function readLedger(): Promise<LarkRecord[]> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  const baseToken = process.env.LARK_EXPENSE_BASE_TOKEN;
  if (!appId || !appSecret || !baseToken)
    throw new Error('Thiếu LARK_APP_ID / LARK_APP_SECRET / LARK_EXPENSE_BASE_TOKEN');
  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
  });
  const records: LarkRecord[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.bitable.appTableRecord.list({
      path: { app_token: baseToken, table_id: LEDGER_TABLE },
      params: {
        page_size: 500,
        automatic_fields: true,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code && res.code !== 0)
      throw new Error(`LarkBase trả lỗi ${res.code}: ${res.msg ?? ''}`);
    for (const item of res.data?.items ?? []) {
      if (!item.record_id) continue;
      const created = Number((item as any).created_time);
      const modified = Number((item as any).last_modified_time);
      records.push({
        recordId: item.record_id,
        fields: (item.fields ?? {}) as Record<string, unknown>,
        createdAt: created > 0 ? new Date(created) : null,
        modifiedAt: modified > 0 ? new Date(modified) : null,
      });
    }
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return records;
}

function sumBy<T extends { branchId: number; amount: unknown }>(rows: T[], branchId: number) {
  const list = rows.filter((row) => row.branchId === branchId);
  return `${list.length} dòng, ${money(list.reduce((s, r) => s + Number(r.amount), 0))}đ`;
}

function report(plan: ReconcilePlan) {
  for (const branchId of [HN, SG]) {
    console.log(`\n── ${NAME[branchId]}`);
    console.log(`1. Thêm dòng sổ quỹ Lark còn thiếu: ${sumBy(plan.add, branchId)}`);
    console.log(
      `   Sửa dòng khác Lark: ${plan.update.filter((u) => u.pos.branchId === branchId).length} dòng`,
    );
    console.log(`   Hủy dòng không còn trên Lark: ${sumBy(plan.removed, branchId)}`);
    console.log(`2. Hủy ghi quỹ trùng (phiếu đã có dòng sổ quỹ Lark): ${sumBy(plan.duplicates, branchId)}`);
    console.log(`3. Hủy khoản tự ghi lúc nhập lịch sử (≤ 10/10): ${sumBy(plan.importPostings, branchId)}`);
    console.log(`   (khoản tự ghi có ngày từ 11/10, giữ nguyên: ${sumBy(plan.importAfterCutoff, branchId)})`);
    if (branchId === HN)
      console.log(`5. Phiếu chưa đồng kiểm trả về chờ kiểm tra: ${sumBy(plan.unchecked, branchId)}`);
    console.log(`6. Chuyển khoản ghi theo approval tuần sang ngày duyệt: ${sumBy(plan.redate, branchId)}`);
    console.log(`   Trong đó dòng thiếu "Ngày Giao Dịch" (giữ, không tính vào quỹ): ${sumBy(plan.missingTradeDate, branchId)}`);
    console.log(
      `   Sổ quỹ Lark từ 11/10: đã có trên POS ${plan.afterCutoff.inPos.filter((r) => r.branchId === branchId).length} dòng, chưa có ${sumBy(plan.afterCutoff.missingInPos, branchId)} (không sửa)`,
    );
  }
  console.log(
    `\n4. Gắn dấu "đã trừ quỹ trên Lark": ${plan.linkedEntryIds.length} phiếu; trong đó thuộc tuần đã duyệt mà chưa Đã chi → Đã chi (không trừ quỹ): ${plan.approvedUnissued._count} phiếu, ${money(plan.approvedUnissued._sum.amount || 0)}đ`,
  );
  console.log('7. Trả về chưa chi (approval tuần đang chờ duyệt):');
  const groups = new Map<string, { n: number; amount: number }>();
  for (const entry of plan.revertIssued) {
    const key = `${NAME[entry.branchId]} – ${entry.weeklyBatch?.code ?? 'chưa vào tuần'}`;
    const group = groups.get(key) || { n: 0, amount: 0 };
    group.n += 1;
    group.amount += Number(entry.amount);
    groups.set(key, group);
  }
  for (const [key, group] of [...groups].sort())
    console.log(`   ${key}: ${group.n} phiếu, ${money(group.amount)}đ`);
  console.log(
    `8. Kho SG – phiếu đã chi được tick đủ "Quản lý kho" và "Kế toán kho": ${plan.sgPaidUnchecked.length} phiếu, ${money(plan.sgPaidUnchecked.reduce((sum, e) => sum + Number(e.amount), 0))}đ`,
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userId = Number(process.argv.find((a) => a.startsWith('--user='))?.split('=')[1]);
  if (apply && !(userId > 0)) throw new Error('Cần --user=<id người thực hiện> khi chạy --apply');
  const prisma = new PrismaClient();
  try {
    const records = await readLedger();
    console.log(`Đọc ${records.length} dòng sổ quỹ trên LarkBase.`);
    const before = { cutoff: await fundBalance(prisma, CUTOFF), now: await fundBalance(prisma) };
    const plan = apply
      ? await applyReconcile(prisma, records, userId)
      : await planReconcile(prisma, records);
    console.log(apply ? '✅ ĐÃ GHI' : '🔍 CHẠY THỬ (chưa ghi gì)');
    report(plan);
    const deltaCutoff = balanceDelta(plan, CUTOFF);
    const deltaNow = balanceDelta(plan);
    console.log('\n── Số dư');
    for (const branchId of [HN, SG]) {
      const afterCutoff = before.cutoff.get(branchId)!.plus(deltaCutoff.get(branchId)!);
      console.log(
        `${NAME[branchId]}: cuối 10/10 ${money(before.cutoff.get(branchId))} → ${money(afterCutoff)} (Lark ${money(LARK_CLOSING_1010[branchId])}, lệch ${money(afterCutoff.minus(LARK_CLOSING_1010[branchId]))}) | hiện tại ${money(before.now.get(branchId))} → ${money(before.now.get(branchId)!.plus(deltaNow.get(branchId)!))}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌', error instanceof Error ? error.message : error);
  process.exit(1);
});
