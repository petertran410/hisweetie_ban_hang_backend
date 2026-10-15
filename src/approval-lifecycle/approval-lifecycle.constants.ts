export type ApprovalRequestKind =
  | 'EXPENSE_HN'
  | 'EXPENSE_SG'
  | 'EXPENSE_VP'
  | 'RECEIPT';

export type ApprovalInstanceStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELED'
  | 'DELETED'
  | 'REVERTED';

export interface ApprovalFormItem {
  id: string;
  type: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface ApprovalDefinition {
  kind: ApprovalRequestKind;
  approvalCode: string;
  formVersion: string;
  requiredFieldIds: string[];
}

export const APPROVAL_FORM_VERSION = '2026-09-26.v1';

export const EXPENSE_FIELD_IDS = {
  common: {
    amount: 'widget17368415755750001',
    detail: 'widget17368416610880001',
    view: 'widget17371739587940001',
  },
  HN: {
    week: 'widget17399397879320001',
    from: 'widget17399508033270001',
    to: 'widget17399508090490001',
  },
  SG: {
    week: 'widget17399388386300001',
    from: 'widget17399508904720001',
    to: 'widget17399508961760001',
  },
  VP: {
    week: 'widget17399388386300001',
    from: 'widget17399508904720001',
    to: 'widget17399508961760001',
    method: 'widget17700954766870001',
    cashSource: 'widget17700955853050001',
  },
} as const;

export const APPROVAL_DEFINITIONS: Record<
  ApprovalRequestKind,
  ApprovalDefinition
> = {
  EXPENSE_HN: {
    kind: 'EXPENSE_HN',
    approvalCode: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
    formVersion: APPROVAL_FORM_VERSION,
    requiredFieldIds: [
      EXPENSE_FIELD_IDS.HN.week,
      EXPENSE_FIELD_IDS.HN.from,
      EXPENSE_FIELD_IDS.HN.to,
      EXPENSE_FIELD_IDS.common.amount,
      EXPENSE_FIELD_IDS.common.detail,
      EXPENSE_FIELD_IDS.common.view,
    ],
  },
  EXPENSE_SG: {
    kind: 'EXPENSE_SG',
    approvalCode: 'AE8660B8-4467-45FE-9878-F3B649372E8C',
    formVersion: APPROVAL_FORM_VERSION,
    requiredFieldIds: [
      EXPENSE_FIELD_IDS.SG.week,
      EXPENSE_FIELD_IDS.SG.from,
      EXPENSE_FIELD_IDS.SG.to,
      EXPENSE_FIELD_IDS.common.amount,
      EXPENSE_FIELD_IDS.common.detail,
      EXPENSE_FIELD_IDS.common.view,
    ],
  },
  EXPENSE_VP: {
    kind: 'EXPENSE_VP',
    approvalCode: 'B06392C2-EE34-486B-AA9C-DB7C53C19142',
    formVersion: APPROVAL_FORM_VERSION,
    requiredFieldIds: [
      EXPENSE_FIELD_IDS.VP.week,
      EXPENSE_FIELD_IDS.VP.from,
      EXPENSE_FIELD_IDS.VP.to,
      EXPENSE_FIELD_IDS.VP.method,
      EXPENSE_FIELD_IDS.common.amount,
      EXPENSE_FIELD_IDS.common.detail,
      EXPENSE_FIELD_IDS.common.view,
    ],
  },
  RECEIPT: {
    kind: 'RECEIPT',
    approvalCode: '09CFDCE2-D026-44C7-A94C-8C6B02660BA1',
    formVersion: APPROVAL_FORM_VERSION,
    requiredFieldIds: [
      'widget17321740179360001',
      'widget17321810360090001',
      'widget17321631178550001',
      'widget17321728506550001',
      'widget17321628654580001',
      'widget17321629138780001',
    ],
  },
};

export const APPROVAL_STATUS_ORDER: Record<ApprovalInstanceStatus, number> = {
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 2,
  CANCELED: 2,
  DELETED: 2,
  REVERTED: 3,
};

export const RECEIPT_FIELD_IDS = {
  classification: 'widget17321740179360001',
  payer: 'widget17321810360090001',
  from: 'widget17863314165550001',
  to: 'widget17863314190270001',
  date: 'widget17321631178550001',
  tempAdvance: 'widget17780590040100001',
  method: 'widget17321728506550001',
  cashSource: 'widget17730449889490001',
  description: 'widget17321628654580001',
  amount: 'widget17321629138780001',
  invoiceFiles: 'widget17321767077360001',
  attachments: 'widget17325176953770001',
} as const;

export const RECEIPT_OPTIONS = {
  classifications: {
    refundAdvance: 'm5yyxva1-0qljlzdgfq2k-1',
    internalTransfer: 'miior6p8-s0rjayqbcv-1',
    other: 'm3qzoq6o-9zz1b70wu0s-0',
  },
  methods: {
    companyTransfer: '$i18n-m3sj1xiv-4ru39bef6i-1',
    personalTransfer: 'm3sj5uh2-zttr08nfqcm-1',
    cash: 'md9r0rqr-tlntv5zjg8-1',
  },
  cashSources: new Set([
    'mmix7h92-hukohb4on6-0',
    'mmix7h92-vnvw9s8fgxd-0',
    'mmix7h92-ouja9bee0j9-0',
    'mmix6zt5-jloc41vsx8k-1',
    'mmix6zt5-9oxlpayncdg-3',
  ]),
} as const;

export const RECEIPT_LOCATION_BRANCHES = {
  from: {
    'msmnlqej-t6tk3qikgcm-0': 6,
    'msmnlqej-osblnddobgd-0': 1,
    'msmnlqej-ayuo9uxg81-0': 4,
    'msmnlqf7-6253w1gahex-1': 7,
  },
  to: {
    'msmnlsb8-4p1ddn0lzf4-0': 6,
    'msmnlsb8-8wr2wdb09lx-0': 1,
    'msmnlsb8-5t1nguy4lg2-0': 4,
    'msmnlqf7-dfecjahtjww-7': 7,
  },
} as const;

export const EXPENSE_VP_OPTIONS = {
  methods: new Set(['ml65570v-ih3r0g47mu-0', 'ml65570v-qr4uobqvu9-0']),
  cashMethod: 'ml65570v-ih3r0g47mu-0',
  cashSources: new Set([
    'ml657iu1-7mvb2xfgje6-0',
    'ml657iu1-n0lwb0zjbi-0',
    'ml657iu1-cu8e9ueqx7n-0',
    'ml657gkh-6nafl75gzil-1',
    'ml657gkh-efnh2mcsfca-3',
    'ml657gkh-dmwqcejrc1s-5',
  ]),
  branchCashSources: {
    4: 'ml657iu1-7mvb2xfgje6-0',
    5: 'ml657iu1-7mvb2xfgje6-0',
    7: 'ml657iu1-n0lwb0zjbi-0',
  },
} as const;

export const APPROVAL_BRANCHES = {
  EXPENSE_HN: 6,
  EXPENSE_SG: 1,
  EXPENSE_VP: new Set([4, 7]),
} as const;

// Đơn "PHIẾU CHI" tạo trực tiếp trên Lark. POS không tạo loại này, chỉ nhận về
// để trừ quỹ nội bộ khi đơn chi tiền mặt được duyệt.
export const PAYMENT_VOUCHER = {
  kind: 'PAYMENT_VOUCHER',
  sourceType: 'LARK_PAYMENT_VOUCHER',
  approvalCode: '2A4BC15D-09F4-44FB-8B51-FD3174D5963B',
  fieldIds: {
    method: 'widget17321753417610001',
    cashSource: 'widget17643292059530001',
    amount: 'widget17321752802850001',
    cashAmount: 'widget17643300136400001',
    description: 'widget17321750170610001',
  },
  // Theo chữ của lựa chọn "Nguồn Tiền Mặt"; nguồn khác (CHDT, không chi tiền mặt) bỏ qua.
  cashSourceBranches: {
    'Tiền Mặt Kho HN': 6,
    'Tiền Mặt Kho SG': 1,
    'Tiền Mặt Văn Phòng HN': 4,
    'Tiền Mặt Văn Phòng HCM': 7,
  } as Record<string, number>,
} as const;

export interface PaymentVoucherCash {
  branchId: number;
  amount: number;
  cashSource: string;
  method: string;
  description: string;
}

/** Phần tiền mặt chi từ quỹ nội bộ của một đơn PHIẾU CHI; null nếu đơn không dùng quỹ. */
export function readPaymentVoucherCash(
  form: ApprovalFormItem[],
): PaymentVoucherCash | null {
  const value = (id: string) => form.find((item) => item.id === id)?.value;
  const text = (id: string) => String(value(id) ?? '').trim();
  const cashSource = text(PAYMENT_VOUCHER.fieldIds.cashSource);
  const branchId = PAYMENT_VOUCHER.cashSourceBranches[cashSource];
  if (!branchId) return null;
  const method = text(PAYMENT_VOUCHER.fieldIds.method);
  const lower = method.toLowerCase();
  // Thanh toán thuần tiền mặt lấy tổng tiền; thanh toán hỗn hợp lấy riêng "Số tiền mặt".
  const cashOnly =
    lower.includes('tiền mặt') && !lower.includes('chuyển khoản');
  const amount = Number(
    value(
      cashOnly
        ? PAYMENT_VOUCHER.fieldIds.amount
        : PAYMENT_VOUCHER.fieldIds.cashAmount,
    ) ?? 0,
  );
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    branchId,
    amount,
    cashSource,
    method,
    description: text(PAYMENT_VOUCHER.fieldIds.description),
  };
}

/** Nguồn quỹ tiền mặt trên form PHIẾU THU ứng với quỹ của từng chi nhánh. */
export const RECEIPT_CASH_SOURCE_BY_BRANCH: Record<number, string> = {
  6: 'mmix7h92-hukohb4on6-0',
  1: 'mmix7h92-vnvw9s8fgxd-0',
  4: 'mmix6zt5-jloc41vsx8k-1',
  7: 'mmix6zt5-9oxlpayncdg-3',
};

export type FundReceiptFromLark =
  | {
      kind: 'TRANSFER';
      sourceBranchId: number;
      destinationBranchId: number;
      amount: number;
      occurredAt: Date;
      description: string;
    }
  | {
      kind: 'RECEIPT';
      branchId: number;
      amount: number;
      occurredAt: Date;
      description: string;
    };

/**
 * Đọc đơn PHIẾU THU tạo trực tiếp trên Lark.
 * - Có nơi đi và nơi nhận đều là quỹ của POS (khác nhau): chuyển quỹ, bất kể
 *   hình thức thu (tiền mặt hay chuyển khoản) và phân loại.
 * - Không có cặp nơi đi / nơi nhận hợp lệ: chỉ nhận đơn thu tiền mặt loại
 *   "khác" / hoàn tạm ứng có chọn nguồn quỹ.
 * Đơn khác trả null để bỏ qua.
 */
export function readFundReceipt(
  form: ApprovalFormItem[],
): FundReceiptFromLark | null {
  const item = (id: string) =>
    form.find((row) => row.id === id) as
      | (ApprovalFormItem & { option?: { key?: string } })
      | undefined;
  // Lark trả lựa chọn dạng chữ ở `value` và mã lựa chọn ở `option.key`.
  const choice = (id: string) =>
    String(item(id)?.option?.key ?? item(id)?.value ?? '').trim();
  const amount = Number(item(RECEIPT_FIELD_IDS.amount)?.value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rawDate = item(RECEIPT_FIELD_IDS.date)?.value;
  const occurredAt = rawDate ? new Date(String(rawDate)) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;
  const description = String(
    item(RECEIPT_FIELD_IDS.description)?.value ?? '',
  ).trim();

  const sourceBranchId = (
    RECEIPT_LOCATION_BRANCHES.from as Record<string, number>
  )[choice(RECEIPT_FIELD_IDS.from)];
  const destinationBranchId = (
    RECEIPT_LOCATION_BRANCHES.to as Record<string, number>
  )[choice(RECEIPT_FIELD_IDS.to)];
  if (
    sourceBranchId &&
    destinationBranchId &&
    sourceBranchId !== destinationBranchId
  ) {
    return {
      kind: 'TRANSFER',
      sourceBranchId,
      destinationBranchId,
      amount,
      occurredAt,
      description: description || 'Chuyển tiền nội bộ',
    };
  }

  if (choice(RECEIPT_FIELD_IDS.method) !== RECEIPT_OPTIONS.methods.cash)
    return null;
  const classification = choice(RECEIPT_FIELD_IDS.classification);
  if (
    classification !== RECEIPT_OPTIONS.classifications.other &&
    classification !== RECEIPT_OPTIONS.classifications.refundAdvance
  )
    return null;
  const cashSource = choice(RECEIPT_FIELD_IDS.cashSource);
  const branchId = Number(
    Object.entries(RECEIPT_CASH_SOURCE_BY_BRANCH).find(
      ([, source]) => source === cashSource,
    )?.[0],
  );
  if (!branchId) return null;
  return {
    kind: 'RECEIPT',
    branchId,
    amount,
    occurredAt,
    description: description || 'Thu quỹ nội bộ',
  };
}

/** Bốn form Lark Approval nhân viên tạo trực tiếp mà POS nhận về để đối chiếu. */
export type LarkFormKind =
  | 'PHIEU_THU'
  | 'PHIEU_CHI'
  | 'PHIEU_CHI_KHO_HN'
  | 'PHIEU_CHI_KHO_SG';

export const LARK_FORM_KINDS: LarkFormKind[] = [
  'PHIEU_THU',
  'PHIEU_CHI',
  'PHIEU_CHI_KHO_HN',
  'PHIEU_CHI_KHO_SG',
];

/** Kho HN (6) và Kho SG (1): đơn tiền mặt của hai quỹ này thành phiếu POS. */
export const LARK_ENTRY_BRANCHES = [6, 1];

/**
 * Ngày dùng hệ thống tài chính nội bộ (14/10/2026): tới hết 13/10 kho ghi tiền
 * ngay vào sổ quỹ Lark Base nên đơn duyệt trước mốc chỉ tạo phiếu, không ghi
 * quỹ lần nữa (trùng DEPLOY_CUTOFF của ledger-deploy-cutoff).
 */
export const LARK_LEDGER_CUTOFF = new Date('2026-10-14T00:00:00+07:00');

export interface LarkInstanceSummary {
  amount: number | null;
  cashAmount: number | null;
  method: string | null;
  cashSource: string | null;
  description: string | null;
  occurredAt: Date | null;
  branchId: number | null;
  direction: 'EXPENSE' | 'RECEIPT' | null;
  inScope: boolean;
  skipReason: string | null;
  /** Quỹ tiền mặt đơn làm thay đổi (chuyển quỹ có hai quỹ). */
  fundBranchIds: number[];
}

const BRANCH_FUND_LABELS: Record<number, string> = {
  6: 'Tiền mặt Kho HN',
  1: 'Tiền mặt Kho SG',
  4: 'Tiền mặt Văn phòng HN',
  7: 'Tiền mặt Văn phòng HCM',
};

function formValue(form: ApprovalFormItem[], id: string) {
  return form.find((item) => item.id === id)?.value;
}

function formText(form: ApprovalFormItem[], id: string) {
  const value = formValue(form, id);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function formNumber(form: ApprovalFormItem[], id: string) {
  const value = Number(formValue(form, id));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function dateKeyOf(value: string | null) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

/**
 * Đọc một đơn Lark của 4 form: số tiền, nguồn tiền, ngày và có thành phiếu
 * Phiếu chi kho / Tài chính nội bộ hay không (chỉ tiền mặt Kho HN / Kho SG).
 * `fallbackDate` là ngày duyệt (hoặc ngày tạo) của đơn.
 */
export function summarizeLarkInstance(
  kind: LarkFormKind,
  form: ApprovalFormItem[],
  fallbackDate: Date | null,
): LarkInstanceSummary {
  if (kind === 'PHIEU_CHI') {
    const ids = PAYMENT_VOUCHER.fieldIds;
    const cash = readPaymentVoucherCash(form);
    const base = {
      amount: formNumber(form, ids.amount),
      cashAmount: cash?.amount ?? formNumber(form, ids.cashAmount),
      method: formText(form, ids.method),
      cashSource: formText(form, ids.cashSource),
      description: formText(form, ids.description),
      occurredAt: fallbackDate,
      direction: 'EXPENSE' as const,
    };
    if (!cash)
      return {
        ...base,
        branchId: null,
        inScope: false,
        skipReason: 'Không chi bằng tiền mặt quỹ nội bộ',
        fundBranchIds: [],
      };
    const inScope = LARK_ENTRY_BRANCHES.includes(cash.branchId);
    return {
      ...base,
      branchId: cash.branchId,
      inScope,
      skipReason: inScope ? null : 'Chi từ quỹ văn phòng',
      fundBranchIds: [cash.branchId],
    };
  }

  if (kind === 'PHIEU_THU') {
    const ids = RECEIPT_FIELD_IDS;
    const receipt = readFundReceipt(form);
    const rawDate = formText(form, ids.date);
    const base = {
      amount: formNumber(form, ids.amount),
      cashAmount: null,
      method: formText(form, ids.method),
      cashSource: formText(form, ids.cashSource),
      description: formText(form, ids.description),
      occurredAt: rawDate ? new Date(rawDate) : fallbackDate,
      direction: 'RECEIPT' as const,
    };
    if (!receipt)
      return {
        ...base,
        branchId: null,
        inScope: false,
        skipReason: 'Không thu tiền mặt vào quỹ nội bộ',
        fundBranchIds: [],
      };
    if (receipt.kind === 'TRANSFER')
      return {
        ...base,
        cashSource: `${BRANCH_FUND_LABELS[receipt.sourceBranchId] || receipt.sourceBranchId} → ${BRANCH_FUND_LABELS[receipt.destinationBranchId] || receipt.destinationBranchId}`,
        branchId: receipt.sourceBranchId,
        inScope: false,
        skipReason: 'Chuyển tiền giữa các quỹ (xem ở Quỹ nội bộ)',
        fundBranchIds: [receipt.sourceBranchId, receipt.destinationBranchId],
      };
    const inScope = LARK_ENTRY_BRANCHES.includes(receipt.branchId);
    return {
      ...base,
      cashSource: base.cashSource || BRANCH_FUND_LABELS[receipt.branchId],
      occurredAt: receipt.occurredAt,
      branchId: receipt.branchId,
      inScope,
      skipReason: inScope ? null : 'Thu vào quỹ văn phòng',
      fundBranchIds: [receipt.branchId],
    };
  }

  // PHIẾU CHI KHO HN / SG là form Approval tuần của POS; đơn nhân viên tự tạo
  // trên Lark (đơn tổng tuần kiểu cũ, đơn gửi lại) chỉ để xem, không ghi quỹ.
  const ids =
    kind === 'PHIEU_CHI_KHO_HN' ? EXPENSE_FIELD_IDS.HN : EXPENSE_FIELD_IDS.SG;
  const branchId = kind === 'PHIEU_CHI_KHO_HN' ? 6 : 1;
  const from = dateKeyOf(formText(form, ids.from));
  const to = dateKeyOf(formText(form, ids.to)) || from;
  const amount = formNumber(form, EXPENSE_FIELD_IDS.common.amount);
  const week = formText(form, ids.week);
  // Ô "Chi tiết" của đơn POS là đường link; đơn nhân viên tạo có thể ghi chữ.
  const detail = formText(form, EXPENSE_FIELD_IDS.common.detail);
  const detailText = detail && !/^https?:\/\//i.test(detail) ? detail : null;
  const range = from && to && from !== to ? ` (${from} → ${to})` : '';
  return {
    amount,
    cashAmount: amount,
    method: null,
    cashSource: BRANCH_FUND_LABELS[branchId],
    description: `${detailText || `Phiếu chi kho${week ? ` tuần ${week}` : ''}`}${range}`,
    occurredAt: from ? new Date(`${from}T00:00:00+07:00`) : fallbackDate,
    branchId,
    direction: 'EXPENSE',
    inScope: false,
    skipReason: 'PHIẾU CHI KHO tạo trên Lark: chỉ xem, không ghi quỹ',
    fundBranchIds: [],
  };
}
