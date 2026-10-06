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
  methods: new Set([
    'ml65570v-ih3r0g47mu-0',
    'ml65570v-qr4uobqvu9-0',
  ]),
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
