// prisma/scripts/sync-salary-advances.ts
//
// Lấy các đơn TẠM ỨNG LƯƠNG trên Lark Approval về POS (trang "Tạm ứng lương").
// Đơn cũ chỉ lưu bản sao để xem, không ghi quỹ (sổ quỹ Lark đã ghi). Đơn tiền
// mặt từ quỹ Kho HN / Kho SG / VPHN đang chờ duyệt, hoặc duyệt từ 02/11/2026,
// được nhận như webhook: duyệt thì trừ quỹ. Chạy thử chỉ đọc. Chạy lại được.
//
// Cách chạy:
//   yarn sync:salary-advances                     # chạy thử, không ghi
//   yarn sync:salary-advances --from=2025-01-01   # chỉ đơn tạo từ ngày này
//   yarn sync:salary-advances --apply             # ghi thật + đăng ký nhận sự kiện

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
import { SALARY_ADVANCE } from '../../src/approval-lifecycle/approval-lifecycle.constants';

const DEFAULT_FROM = '2024-11-01';
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
const arg = (name: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const apply = process.argv.includes('--apply');
  const fromKey = arg('from') || DEFAULT_FROM;
  const from = new Date(`${fromKey}T00:00:00+07:00`);
  if (Number.isNaN(from.getTime()))
    throw new Error('--from phải là YYYY-MM-DD');

  const config = new ConfigService();
  const appId = config.get<string>('LARK_APP_ID');
  const appSecret = config.get<string>('LARK_APP_SECRET');
  if (!appId || !appSecret)
    throw new Error('Thiếu LARK_APP_ID / LARK_APP_SECRET trong .env');
  const approvalCode =
    config.get<string>('LARK_SALARY_ADVANCE_APPROVAL_CODE') ||
    SALARY_ADVANCE.approvalCode;
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
    const codes = await mirror.listInstanceCodes(
      approvalCode,
      from,
      new Date(),
    );
    console.log(`TẠM ỨNG LƯƠNG: ${codes.length} đơn trên Lark (từ ${fromKey})`);

    const counts = new Map<string, { n: number; amount: number }>();
    const bump = (key: string, amount: number) => {
      const row = counts.get(key) || { n: 0, amount: 0 };
      row.n += 1;
      row.amount += amount;
      counts.set(key, row);
    };
    const fundPosts: string[] = [];
    let printedForm = false;

    for (const instanceCode of codes) {
      const preview = await retryLark(() =>
        approval.previewLarkInstance(instanceCode, approvalCode),
      );
      if (!preview || preview.outcome === 'POS') continue;
      const { summary } = preview;
      if (!printedForm) {
        printedForm = true;
        const form = JSON.parse(preview.detail?.form || '[]');
        console.log(
          'Các ô form:',
          form.map((item: any) => `${item.name} (${item.id})`).join(', '),
        );
      }
      const amount = summary.amount || 0;
      const cash = summary.cashAmount !== null;
      bump(`Trạng thái ${preview.status || '?'}`, amount);
      bump(
        cash ? `Tiền mặt · ${summary.cashSource || '?'}` : 'Chuyển khoản',
        amount,
      );
      // Ghi như webhook: đơn tiền mặt quỹ POS đang chờ duyệt (duyệt sau sẽ trừ
      // quỹ) hoặc duyệt từ mốc. Còn lại chỉ lưu bản sao.
      const live =
        summary.inScope &&
        (preview.status === 'PENDING' || preview.fund === 'post');
      if (preview.fund === 'post')
        fundPosts.push(
          `${vnDate(preview.completedAt)} · ${summary.description} · ${summary.cashSource} · ${money(amount)}`,
        );
      bump(
        live ? 'Nhận như webhook' : 'Chỉ lưu bản sao (không ghi quỹ)',
        amount,
      );
      if (!apply) continue;
      if (live)
        await approval.syncLarkInstance(instanceCode, approvalCode, {
          knownDetail: preview.detail,
        });
      else
        await mirror.save({
          instanceCode,
          approvalCode,
          kind: 'TAM_UNG_LUONG',
          detail: preview.detail,
          inspected: {
            summary,
            suspectDuplicateOfId: preview.suspectDuplicateOfId,
          },
        });
    }

    console.log(apply ? '\n✅ ĐÃ GHI THẬT' : '\n🔎 CHẠY THỬ (không ghi DB)');
    for (const [key, value] of [...counts.entries()].sort())
      console.log(`  ${key}: ${value.n} đơn, ${money(value.amount)}`);
    console.log(`Đơn sẽ trừ quỹ POS: ${fundPosts.length}`);
    for (const line of fundPosts) console.log(`  - ${line}`);

    if (apply) {
      // Đăng ký nhận sự kiện duyệt của form để webhook về ngay; lỗi (đã đăng
      // ký, thiếu quyền) thì cron mỗi giờ vẫn lấy đơn.
      try {
        const res: any = await larkClient.request({
          method: 'POST',
          url: `/open-apis/approval/v4/approvals/${approvalCode}/subscribe`,
        });
        console.log(
          res?.code ? `Đăng ký sự kiện: ${res.msg}` : 'Đã đăng ký sự kiện form',
        );
      } catch (error: any) {
        const data = error?.response?.data;
        console.log(
          `Đăng ký sự kiện: ${data?.msg || error?.message} (cron mỗi giờ vẫn lấy đơn)`,
        );
      }
    } else console.log('👉 Đồng ý thì chạy lại với --apply.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌ Lỗi:', error?.message || error);
  process.exit(1);
});
