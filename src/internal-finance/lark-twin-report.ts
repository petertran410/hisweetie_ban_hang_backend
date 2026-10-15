import {
  plateHints,
  refundByBranch,
  twinText,
  vehiclePlate,
  vnDay,
  type MergeAction,
  type TwinBasis,
  type TwinPlan,
  type TwinRow,
} from './lark-twin-dedupe';
import { HN, SG } from './legacy-fund-reconcile';

/**
 * Báo cáo của `yarn dedupe:lark-twins`: tóm tắt ngắn cho terminal và các
 * sheet chi tiết (mỗi dòng một phiếu) để ghi ra file Excel.
 */
export const BRANCH_NAME: Record<number, string> = {
  [HN]: 'Kho HN',
  [SG]: 'Kho SG',
};

const BASIS_LABEL: Record<TwinBasis, string> = {
  time: 'Cùng thời điểm',
  plate: 'Biển số',
  item: 'Khoản mục xe',
  note: 'Ghi chú',
};

const ACTION_LABEL: Record<MergeAction, string> = {
  moveBatch: 'Chuyển tuần Approval sang phiếu giữ',
  detachSameBatch: 'Cả hai cùng tuần: gỡ bản sao khỏi tuần',
  moveCash: 'Chuyển Đã chi (và giao dịch quỹ) sang phiếu giữ',
  cancelDoubleFund: 'TRỪ QUỸ HAI LẦN: hủy giao dịch quỹ của bản sao',
};

export const money = (value: unknown) =>
  Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 0 });

export interface ReportSheet {
  name: string;
  columns: Array<{ header: string; key: string; width: number }>;
  rows: Array<Record<string, string | number>>;
}

const batchLabel = (row: TwinRow) =>
  row.weeklyBatch ? `${row.weeklyBatch.code} (${row.weeklyBatch.status})` : '';

export function buildTwinReport(
  plan: TwinPlan,
  balanceBefore: Map<number, unknown>,
) {
  const refund = refundByBranch(plan);
  const summary: string[] = [];
  for (const branchId of [HN, SG]) {
    const merges = plan.merges.filter((m) => m.dup.branchId === branchId);
    const count = (filter: (m: (typeof merges)[number]) => boolean) =>
      merges.filter(filter).length;
    const total = (kind: 'vehicle' | 'packing') =>
      merges
        .filter((m) => m.kind === kind)
        .reduce((sum, m) => sum + Number(m.dup.amount), 0);
    const now = Number(balanceBefore.get(branchId) || 0);
    const back = refund.get(branchId) || 0;
    summary.push(
      `===== ${BRANCH_NAME[branchId]} =====`,
      `Cặp phiếu xe sẽ gộp: ${count((m) => m.kind === 'vehicle')} cặp, ${money(total('vehicle'))}đ` +
        ` (cùng thời điểm ${count((m) => m.basis === 'time')}, biển số ${count((m) => m.basis === 'plate')}, khoản mục xe ${count((m) => m.basis === 'item')}, ghi chú ${count((m) => m.basis === 'note')})`,
      `Cặp cước báo đơn sẽ gộp: ${count((m) => m.kind === 'packing')} cặp, ${money(total('packing'))}đ`,
      ...(Object.keys(ACTION_LABEL) as MergeAction[])
        .map(
          (action) =>
            [action, count((m) => m.actions.includes(action))] as const,
        )
        .filter(([, n]) => n > 0)
        .map(([action, n]) => `- ${ACTION_LABEL[action]}: ${n} cặp`),
      `Số dư quỹ: ${money(now)} → ${money(now + back)} (cộng lại ${money(back)})`,
      '',
    );
  }
  const manualCount =
    plan.skipped.length +
    plan.ambiguous.length +
    plan.plateMissing.length +
    plan.packingMismatched.length;
  summary.push(
    `Cần kiểm tay: ${manualCount} dòng`,
    `Nghi trùng (chỉ xem, không tự gộp): ${plan.suspects.length} nhóm, ${plan.suspects.reduce((n, g) => n + g.length, 0)} phiếu`,
  );

  const merged: ReportSheet = {
    name: 'Sẽ gộp',
    columns: [
      { header: 'Kho', key: 'branch', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Loại', key: 'kind', width: 10 },
      { header: 'Ghép theo', key: 'basis', width: 14 },
      { header: 'Biển trên bản sao', key: 'dupPlate', width: 18 },
      { header: 'Biển phiếu giữ', key: 'keepPlate', width: 16 },
      { header: 'Mã bản sao (hủy)', key: 'dupCode', width: 30 },
      { header: 'Nội dung bản sao', key: 'dupText', width: 45 },
      { header: 'Mã phiếu giữ', key: 'keepCode', width: 30 },
      { header: 'Nội dung phiếu giữ', key: 'keepText', width: 45 },
      { header: 'Việc làm', key: 'actions', width: 50 },
      { header: 'Tuần của bản sao', key: 'batch', width: 34 },
    ],
    rows: plan.merges.map((m) => ({
      branch: BRANCH_NAME[m.dup.branchId] || String(m.dup.branchId),
      date: vnDay(m.dup.occurredAt),
      amount: Number(m.dup.amount),
      kind: m.kind === 'vehicle' ? 'Phiếu xe' : 'Báo đơn',
      basis: m.basis ? BASIS_LABEL[m.basis] : 'Mã báo đơn',
      dupPlate: plateHints(twinText(m.dup)).join(', '),
      keepPlate: m.kind === 'vehicle' ? vehiclePlate(m.keep) : '',
      dupCode: m.dup.code,
      dupText: [m.dup.description, m.dup.note].filter(Boolean).join(' | '),
      keepCode: m.keep.code,
      keepText: [m.keep.description, m.keep.note].filter(Boolean).join(' | '),
      actions: m.actions.map((action) => ACTION_LABEL[action]).join('; '),
      batch: batchLabel(m.dup),
    })),
  };

  const manualRow = (dup: TwinRow, reason: string, candidates: string) => ({
    branch: BRANCH_NAME[dup.branchId] || String(dup.branchId),
    date: vnDay(dup.occurredAt),
    amount: Number(dup.amount),
    code: dup.code,
    text: [dup.description, dup.note].filter(Boolean).join(' | '),
    reason,
    candidates,
  });
  const manual: ReportSheet = {
    name: 'Cần kiểm tay',
    columns: [
      { header: 'Kho', key: 'branch', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Mã bản sao', key: 'code', width: 30 },
      { header: 'Nội dung', key: 'text', width: 45 },
      { header: 'Lý do', key: 'reason', width: 40 },
      { header: 'Phiếu có thể trùng', key: 'candidates', width: 60 },
    ],
    rows: [
      ...plan.skipped.map((s) => manualRow(s.dup, s.reason, s.keep.code)),
      ...plan.ambiguous.map((a) =>
        manualRow(
          a.dup,
          'Khớp nhiều phiếu xe',
          a.keeps.map((k) => k.code).join(', '),
        ),
      ),
      ...plan.plateMissing.map((m) =>
        manualRow(
          m.dup,
          `Ghi biển ${m.hints.join(', ')} nhưng ngày đó không có phiếu xe của biển này cùng số tiền`,
          m.keeps.map((k) => `${k.code} (${vehiclePlate(k)})`).join(', '),
        ),
      ),
      ...plan.packingMismatched.map((m) =>
        manualRow(
          m.dup,
          'Cước báo đơn lệch số tiền',
          `${m.keep.code} (${money(m.keep.amount)}đ)`,
        ),
      ),
    ],
  };

  const suspects: ReportSheet = {
    name: 'Nghi trùng',
    columns: [
      { header: 'Nhóm', key: 'group', width: 8 },
      { header: 'Kho', key: 'branch', width: 10 },
      { header: 'Ngày', key: 'date', width: 12 },
      { header: 'Số tiền', key: 'amount', width: 14 },
      { header: 'Mã phiếu', key: 'code', width: 30 },
      { header: 'Nguồn', key: 'source', width: 26 },
      { header: 'Nội dung', key: 'text', width: 50 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Người chi', key: 'payer', width: 20 },
    ],
    rows: plan.suspects.flatMap((group, index) =>
      group.map((row) => ({
        group: index + 1,
        branch: BRANCH_NAME[row.branchId] || String(row.branchId),
        date: vnDay(row.occurredAt),
        amount: Number(row.amount),
        code: row.code,
        source: `${row.sourceType} / ${row.category}`,
        text: row.description || '',
        note: row.note || '',
        payer: row.payer?.name || '',
      })),
    ),
  };

  const summarySheet: ReportSheet = {
    name: 'Tóm tắt',
    columns: [{ header: 'Tóm tắt', key: 'line', width: 110 }],
    rows: summary.map((line) => ({ line })),
  };

  return { summary, sheets: [summarySheet, merged, manual, suspects] };
}
