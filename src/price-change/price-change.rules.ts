// Luật chuyển bước / quyền thao tác của phiếu thay đổi giá (hàm thuần, có spec).
import {
  FINAL_STAGES,
  MAX_ITEMS,
  PC_ACTION,
  PC_DECISION,
  PC_STAGE,
  PC_STATUS,
  PERM,
  PcAction,
  PcGroup,
  PcStage,
  PcStatus,
  STAGE_GROUP,
} from './price-change.constants';
import type { CostLine, PriceLine } from './price-change.constants';

export interface RuleTicket {
  stage: string;
  createdById?: number | null;
  hasCost?: boolean | null;
  kttDecision?: string | null;
  ceoDecision?: string | null;
}

export interface RuleActor {
  id: number;
  isSuperAdmin: boolean;
  permissions: string[];
}

export type ApproverMap = Partial<Record<PcGroup, number[]>>;

export function isFinalStage(stage: string): boolean {
  return (FINAL_STAGES as string[]).includes(stage);
}

/** Các bước phiếu đi qua: có đổi giá vốn thì thêm bước CEO. */
export function stagePath(hasCost: boolean): PcStage[] {
  return hasCost
    ? [
        PC_STAGE.PROPOSAL,
        PC_STAGE.CHIEF_ACCOUNTANT,
        PC_STAGE.CEO,
        PC_STAGE.DATA,
        PC_STAGE.DONE,
      ]
    : [
        PC_STAGE.PROPOSAL,
        PC_STAGE.CHIEF_ACCOUNTANT,
        PC_STAGE.DATA,
        PC_STAGE.DONE,
      ];
}

/** Bước kế tiếp khi bước hiện tại được duyệt / hoàn tất. */
export function nextStage(stage: string, hasCost: boolean): PcStage | null {
  const path = stagePath(hasCost);
  const i = path.indexOf(stage as PcStage);
  return i >= 0 && i < path.length - 1 ? path[i + 1] : null;
}

/** Có quyết định Từ chối → Rejected; đã tới Phòng Dữ Liệu / Hoàn thành → Approved. */
export function computeStatus(ticket: RuleTicket): PcStatus {
  if (
    ticket.kttDecision === PC_DECISION.REJECTED ||
    ticket.ceoDecision === PC_DECISION.REJECTED
  ) {
    return PC_STATUS.REJECTED;
  }
  if (ticket.stage === PC_STAGE.DATA || ticket.stage === PC_STAGE.DONE) {
    return PC_STATUS.APPROVED;
  }
  return PC_STATUS.UNDER_REVIEW;
}

export interface ItemInput {
  productId: number | null;
  productCode?: string;
  costs: CostLine[];
  prices: PriceLine[];
}

export interface ItemCheck {
  errors: string[];
  hasCost: boolean;
  hasSale: boolean;
}

/**
 * Kiểm tra cấu trúc dòng (dùng cả khi lưu nháp): cột thuộc danh sách đã chọn,
 * giá ≥ 0, không trùng sản phẩm, không quá MAX_ITEMS dòng.
 */
export function checkItems(
  items: ItemInput[],
  costBranchIds: number[],
  priceBookIds: number[],
): ItemCheck {
  const errors: string[] = [];
  let hasCost = false;
  let hasSale = false;
  if (items.length > MAX_ITEMS)
    errors.push(`Mỗi phiếu tối đa ${MAX_ITEMS} sản phẩm`);
  const seen = new Set<number>();
  for (const item of items) {
    const label = item.productCode || `#${item.productId ?? '?'}`;
    if (item.productId !== null) {
      if (seen.has(item.productId))
        errors.push(`Sản phẩm ${label} bị lặp trong phiếu`);
      seen.add(item.productId);
    }
    for (const c of item.costs) {
      if (!costBranchIds.includes(c.branchId))
        errors.push(`${label}: chi nhánh "${c.branchName}" chưa được chọn`);
      if (c.newCost !== null) {
        if (!(c.newCost >= 0)) errors.push(`${label}: giá vốn phải ≥ 0`);
        hasCost = true;
      }
    }
    for (const p of item.prices) {
      if (!priceBookIds.includes(p.priceBookId))
        errors.push(`${label}: bảng giá "${p.priceBookName}" chưa được chọn`);
      if (p.newPrice !== null) {
        if (!(p.newPrice >= 0)) errors.push(`${label}: giá bán phải ≥ 0`);
        hasSale = true;
      }
    }
  }
  return { errors, hasCost, hasSale };
}

/** Lý do chưa gửi duyệt được (null = gửi được). */
export function submitBlockReason(items: ItemInput[]): string | null {
  if (!items.length) return 'Phiếu chưa có sản phẩm nào';
  const empty = items.filter(
    (i) =>
      !i.costs.some((c) => c.newCost !== null) &&
      !i.prices.some((p) => p.newPrice !== null),
  );
  if (empty.length) {
    const codes = empty
      .slice(0, 5)
      .map((i) => i.productCode || `#${i.productId}`)
      .join(', ');
    return `Chưa nhập giá mới cho: ${codes}${empty.length > 5 ? '…' : ''}`;
  }
  if (items.some((i) => i.productId === null))
    return 'Có dòng chưa khớp sản phẩm trên POS';
  return null;
}

function inGroup(approvers: ApproverMap, group: PcGroup, userId: number) {
  return (approvers[group] ?? []).includes(userId);
}

/** Người dùng có phải người xử lý bước `stage` của phiếu không. */
export function isStageActor(
  ticket: RuleTicket,
  stage: string,
  actor: RuleActor,
  approvers: ApproverMap,
): boolean {
  if (actor.isSuperAdmin) return true;
  if (stage === PC_STAGE.PROPOSAL) return ticket.createdById === actor.id;
  const group = STAGE_GROUP[stage as PcStage];
  return group ? inGroup(approvers, group, actor.id) : false;
}

export interface TicketAccess {
  actions: PcAction[];
  isStageActor: boolean;
  canEdit: boolean;
}

/** Hành động được phép của một người trên phiếu. */
export function resolveAccess(
  ticket: RuleTicket,
  actor: RuleActor,
  approvers: ApproverMap,
): TicketAccess {
  const actions: PcAction[] = [PC_ACTION.COMMENT];
  if (isFinalStage(ticket.stage)) {
    return { actions, isStageActor: false, canEdit: false };
  }
  const stageActor = isStageActor(ticket, ticket.stage, actor, approvers);
  switch (ticket.stage) {
    case PC_STAGE.PROPOSAL:
      if (stageActor) actions.push(PC_ACTION.EDIT, PC_ACTION.SUBMIT);
      break;
    case PC_STAGE.CHIEF_ACCOUNTANT:
      if (stageActor) actions.push(PC_ACTION.KTT_DECIDE);
      break;
    case PC_STAGE.CEO:
      if (stageActor) actions.push(PC_ACTION.CEO_DECIDE);
      break;
    case PC_STAGE.DATA:
      if (stageActor) actions.push(PC_ACTION.APPLY, PC_ACTION.SEND_BACK);
      break;
  }
  if (
    actor.isSuperAdmin ||
    actor.permissions.includes(PERM.CONFIG) ||
    (ticket.stage === PC_STAGE.PROPOSAL && ticket.createdById === actor.id)
  ) {
    actions.push(PC_ACTION.END);
  }
  return {
    actions,
    isStageActor: stageActor,
    canEdit: actions.includes(PC_ACTION.EDIT),
  };
}
