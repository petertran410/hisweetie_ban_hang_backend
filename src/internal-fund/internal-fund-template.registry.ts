import { BadRequestException } from '@nestjs/common';
import {
  APPROVAL_DEFINITIONS,
  RECEIPT_FIELD_IDS,
  RECEIPT_LOCATION_BRANCHES,
  RECEIPT_OPTIONS,
  type ApprovalFormItem,
} from '../approval-lifecycle/approval-lifecycle.constants';
import { CreateInternalFundReceiptApprovalDto } from './dto/internal-fund.dto';
import { fundDateKey } from './internal-fund-ledger.service';

export const INTERNAL_FUND_TEMPLATES = {
  PHIEU_CHI_HN: APPROVAL_DEFINITIONS.EXPENSE_HN,
  PHIEU_CHI_SG: APPROVAL_DEFINITIONS.EXPENSE_SG,
  PHIEU_CHI_VP: APPROVAL_DEFINITIONS.EXPENSE_VP,
  PHIEU_THU: APPROVAL_DEFINITIONS.RECEIPT,
};

const sources: Record<number, string> = {
  6: 'mmix7h92-hukohb4on6-0',
  1: 'mmix7h92-vnvw9s8fgxd-0',
  4: 'mmix6zt5-jloc41vsx8k-1',
  7: 'mmix6zt5-9oxlpayncdg-3',
};

const sourceLabels: Record<string, string> = {
  'mmix7h92-hukohb4on6-0': 'Quỹ tiền mặt Kho Hà Nội',
  'mmix7h92-vnvw9s8fgxd-0': 'Quỹ tiền mặt Kho Sài Gòn',
  'mmix6zt5-jloc41vsx8k-1': 'Quỹ tiền mặt Văn phòng',
  'mmix6zt5-9oxlpayncdg-3': 'Quỹ tiền mặt VPSG',
};

export function fundCashSourceLabel(value: unknown) {
  return sourceLabels[String(value || '')] || String(value || '');
}

export function buildFundReceiptForm(
  dto: CreateInternalFundReceiptApprovalDto,
  payer: string,
): ApprovalFormItem[] {
  if (dto.method && dto.method !== 'cash')
    throw new BadRequestException('Quỹ tiền mặt chỉ nhận hình thức tiền mặt');
  if (!sources[dto.branchId])
    throw new BadRequestException('Chưa cấu hình nguồn quỹ');
  if (!dto.attachmentCodes?.length)
    throw new BadRequestException('Cần chứng từ Approval');
  if (dto.classification === 'REFUND_ADVANCE' && !dto.tempAdvance?.trim())
    throw new BadRequestException('Cần tên tạm ứng');
  const classification =
    dto.classification === 'INTERNAL_TRANSFER'
      ? RECEIPT_OPTIONS.classifications.internalTransfer
      : dto.classification === 'REFUND_ADVANCE'
        ? RECEIPT_OPTIONS.classifications.refundAdvance
        : RECEIPT_OPTIONS.classifications.other;
  const form: ApprovalFormItem[] = [
    {
      id: RECEIPT_FIELD_IDS.classification,
      type: 'radioV2',
      value: classification,
    },
    {
      id: RECEIPT_FIELD_IDS.payer,
      type: 'contact',
      value: [dto.payerOpenId || payer],
    },
    {
      id: RECEIPT_FIELD_IDS.date,
      type: 'date',
      value: fundDateKey(dto.occurredAt),
    },
    {
      id: RECEIPT_FIELD_IDS.method,
      type: 'radioV2',
      value: RECEIPT_OPTIONS.methods.cash,
    },
    {
      id: RECEIPT_FIELD_IDS.cashSource,
      type: 'radioV2',
      value: sources[dto.branchId],
    },
    { id: RECEIPT_FIELD_IDS.amount, type: 'amount', value: dto.amount },
    {
      id: RECEIPT_FIELD_IDS.description,
      type: 'textarea',
      value: dto.description?.trim() || 'Thu quỹ nội bộ',
    },
    {
      id: RECEIPT_FIELD_IDS.invoiceFiles,
      type: 'attachmentV2',
      value: dto.attachmentCodes,
    },
  ];
  if (dto.tempAdvance)
    form.push({
      id: RECEIPT_FIELD_IDS.tempAdvance,
      type: 'radioV2',
      value: dto.tempAdvance,
    });
  if (dto.classification === 'INTERNAL_TRANSFER') {
    if (!dto.destinationBranchId || dto.destinationBranchId === dto.branchId)
      throw new BadRequestException('Quỹ nguồn và đích phải khác nhau');
    const from = Object.entries(RECEIPT_LOCATION_BRANCHES.from).find(
      ([, id]) => id === dto.branchId,
    )?.[0];
    const to = Object.entries(RECEIPT_LOCATION_BRANCHES.to).find(
      ([, id]) => id === dto.destinationBranchId,
    )?.[0];
    if (!from || !to)
      throw new BadRequestException('Chưa cấu hình địa điểm Approval');
    form.push(
      { id: RECEIPT_FIELD_IDS.from, type: 'radioV2', value: from },
      { id: RECEIPT_FIELD_IDS.to, type: 'radioV2', value: to },
    );
  }
  return form;
}
