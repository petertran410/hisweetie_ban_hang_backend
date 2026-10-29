// prisma/scripts/mirror-vphn-entries.ts
//
// Văn phòng HN: các đơn PHIẾU CHI / PHIẾU THU trên Lark mà POS đã nhận về
// trước khi mở phạm vi cho VPHN chưa có phiếu ở Tài chính nội bộ. Script đọc
// lại từng đơn như webhook (bản sao + phiếu), quỹ không ghi lại: đơn duyệt
// trước 01/11/2026 đã có sổ quỹ Lark chép sang, đơn từ 01/11 webhook tự ghi.
// Chạy SAU khi deploy mã mới và sau `yarn import:vphn-ledger --apply`.
//
// Cách chạy:
//   yarn mirror:vphn-entries              # chạy thử, không ghi
//   yarn mirror:vphn-entries --apply      # ghi thật

import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InternalFundLedgerService } from '../../src/internal-fund/internal-fund-ledger.service';
import { InternalFinanceCodeService } from '../../src/internal-finance/internal-finance-code.service';
import { ApprovalLifecycleService } from '../../src/approval-lifecycle/approval-lifecycle.service';
import {
  LarkApprovalMirrorService,
  retryLark,
} from '../../src/approval-lifecycle/lark-approval-mirror.service';

const VPHN = 4;
const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};
const money = (value: number) => value.toLocaleString('vi-VN');
const vnDate = (value: Date | null | undefined) =>
  value
    ? value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    : '';

async function main() {
  const apply = process.argv.includes('--apply');
  const config = new ConfigService();
  const appId = config.get<string>('LARK_APP_ID');
  const appSecret = config.get<string>('LARK_APP_SECRET');
  if (!appId || !appSecret)
    throw new Error('Thiếu LARK_APP_ID / LARK_APP_SECRET trong .env');
  const larkClient = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
    logger: silentLogger,
  });
  const prisma = new PrismaService();
  const ledger = new InternalFundLedgerService();
  const mirror = new LarkApprovalMirrorService(
    prisma,
    larkClient,
    ledger,
    new InternalFinanceCodeService(),
  );
  const approval = new ApprovalLifecycleService(
    prisma,
    config,
    larkClient,
    ledger,
    mirror,
  );

  try {
    // Đơn Lark của quỹ VPHN mà POS đã nhận (PHIẾU CHI tiền mặt VPHN, PHIẾU THU
    // vào VPHN). Chuyển tiền kho → VPHN ghi theo quỹ kho, không có phiếu.
    const requests = await prisma.approvalRequest.findMany({
      where: {
        branchId: VPHN,
        clientUuid: { startsWith: 'LARK:' },
        instanceCode: { not: null },
      },
      select: {
        id: true,
        instanceCode: true,
        approvalCode: true,
        status: true,
        completedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    console.log(`Đơn Lark quỹ VPHN đã có trên POS: ${requests.length}`);

    const counts = new Map<string, number>();
    const bump = (key: string) => counts.set(key, (counts.get(key) || 0) + 1);
    let entryAmount = 0;
    for (const request of requests) {
      const instanceCode = request.instanceCode!;
      const preview = await retryLark(() =>
        approval.previewLarkInstance(instanceCode, request.approvalCode, [
          VPHN,
        ]),
      );
      if (!preview || preview.outcome === 'POS') {
        bump('Bỏ qua: đơn POS gửi');
        continue;
      }
      const amount = preview.summary.cashAmount ?? preview.summary.amount ?? 0;
      let result: string;
      if (preview.existingEntry) result = 'Đã có phiếu';
      else if (preview.status !== 'APPROVED')
        result = `Chưa tạo phiếu: Lark ${preview.status || '?'}`;
      else if (!preview.summary.inScope)
        result = `Ngoài phạm vi: ${preview.summary.skipReason || ''}`;
      else if (preview.fund === 'post')
        result = 'Tạo phiếu + ghi quỹ (đơn duyệt từ 01/11)';
      else result = 'Tạo phiếu (quỹ đã có theo sổ Lark)';
      if (result.startsWith('Tạo phiếu')) entryAmount += amount;
      bump(result);
      console.log(
        `  #${request.id} ${vnDate(preview.completedAt)} ${money(amount)} · ${preview.summary.description || ''} → ${result}`,
      );
      if (apply)
        await approval.syncLarkInstance(instanceCode, request.approvalCode, {
          knownDetail: preview.detail,
          fundBranches: [VPHN],
        });
    }

    console.log(apply ? '\n✅ ĐÃ GHI THẬT' : '\n🔎 CHẠY THỬ (không ghi DB)');
    for (const [key, value] of [...counts.entries()].sort())
      console.log(`  ${key}: ${value}`);
    console.log(`Tổng tiền phiếu tạo mới: ${money(entryAmount)}`);
    if (!apply) console.log('👉 Đồng ý thì chạy lại với --apply.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌ Lỗi:', error?.message || error);
  process.exit(1);
});
