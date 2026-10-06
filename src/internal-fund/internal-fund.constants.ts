export const INTERNAL_FUND_TRANSACTION_TYPE = {
  RECEIPT: 'RECEIPT',
  EXPENSE: 'EXPENSE',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
} as const;

export const INTERNAL_FUND_STATUS = {
  POSTED: 'POSTED',
  CANCELLED: 'CANCELLED',
} as const;

export const INTERNAL_FUND_CLOSING_STATUS = {
  PENDING: 'PENDING',
  MATCHED: 'MATCHED',
  MISMATCHED: 'MISMATCHED',
} as const;

export const INTERNAL_FUND_SCOPE_BRANCHES = {
  hn: [6],
  sg: [1],
  vp: [4, 7],
} as const;

export type InternalFundScope = keyof typeof INTERNAL_FUND_SCOPE_BRANCHES;
export interface InternalFundActor {
  id: number;
  roles?: string[];
}
export type InternalFundPermissionAction =
  | 'view'
  | 'create_receipt'
  | 'create_expense'
  | 'transfer'
  | 'submit_approval'
  | 'mark_issued'
  | 'mark_received'
  | 'close'
  | 'cancel'
  | 'adjust';
