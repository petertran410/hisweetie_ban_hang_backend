// Quy tắc luồng (hàm thuần, không đụng DB) — dựng theo cấu hình trường Flow
// "Quá trình thực hiện" trên Lark: trường bắt buộc/tùy chọn của từng bước,
// công thức "Trạng thái", và ai được thao tác bước nào.
import {
  FINAL_STAGES,
  MANUFACTURED_PARENT,
  NPP_ACTION,
  NPP_DECISION,
  NPP_GROUP,
  NPP_STAGE,
  NPP_STATUS,
  NppAction,
  NppGroup,
  NppStage,
  NppStatus,
  PERM,
  STAGE_GROUP,
  fieldLabel,
} from './new-product-price.constants';

export type FieldKind = 'string' | 'number' | 'int' | 'date' | 'json';

/** Kiểu dữ liệu của mọi trường sửa được qua PATCH. */
export const FIELD_KINDS: Record<string, FieldKind> = {
  productName: 'string',
  parentName: 'string',
  childName: 'string',
  middleName: 'string',
  tradeMarkId: 'int',
  unit: 'string',
  netWeightGram: 'number',
  description: 'string',
  costApproverId: 'int',
  supplierId: 'int',
  factoryId: 'int',
  moqCartons: 'number',
  deliveryTerms: 'string',
  importName: 'string',
  arrivalDate: 'date',
  launchDate: 'date',
  packingSpec: 'number',
  goodsPrice: 'number',
  exchangeRate: 'number',
  vatTax: 'number',
  importTax: 'number',
  overheadCost: 'number',
  costHn: 'number',
  costSg: 'number',
  misaCode: 'string',
  cogsHn: 'number',
  cogsSg: 'number',
  cogsDt: 'number',
  priceHnRetail: 'number',
  priceHnWholesale: 'number',
  priceSgRetail: 'number',
  priceSgWholesale: 'number',
  priceDlcl: 'number',
  priceShopee: 'number',
  priceOem: 'number',
  oemPriceBookId: 'int',
  oemCustomers: 'json',
  note: 'string',
  images: 'json',
  documents: 'json',
};

interface StageFieldSpec {
  required: string[];
  optional: string[];
}

/** Trường của từng bước, đúng cấu hình Flow trên Lark (dấu * = bắt buộc). */
export const STAGE_FIELDS: Partial<Record<NppStage, StageFieldSpec>> = {
  PROPOSAL: {
    required: [
      'productName',
      'parentName',
      'childName',
      'tradeMarkId',
      'unit',
      'netWeightGram',
    ],
    optional: ['description', 'costApproverId', 'images'],
  },
  PURCHASING: {
    // Giá hàng VNĐ = Giá hàng × Tỉ giá (trống tỉ giá → tính như 1).
    required: ['packingSpec', 'middleName', 'goodsPrice'],
    optional: [
      'supplierId',
      'factoryId',
      'arrivalDate',
      'exchangeRate',
      'costHn',
      'costSg',
      'moqCartons',
      'deliveryTerms',
      'importName',
      'images',
      'vatTax',
      'importTax',
      'overheadCost',
    ],
  },
  ACCOUNTING: {
    required: ['cogsHn', 'cogsSg', 'cogsDt'],
    optional: ['misaCode'],
  },
  SALES: {
    required: [],
    optional: [
      'priceHnRetail',
      'priceHnWholesale',
      'priceSgRetail',
      'priceSgWholesale',
      'priceDlcl',
      'priceShopee',
      'priceOem',
      'oemPriceBookId',
      'oemCustomers',
      'launchDate',
    ],
  },
};

/** Mô tả sản phẩm: nhập song song khi phiếu ở Đề xuất hoặc Thu Mua. */
export const PARALLEL_FIELDS = ['description'];
const PARALLEL_STAGES: NppStage[] = [NPP_STAGE.PROPOSAL, NPP_STAGE.PURCHASING];

/** Người xử lý bước hiện tại luôn sửa được. */
export const COMMON_FIELDS = ['note', 'documents'];

/** Phòng Dữ Liệu chuẩn hóa dữ liệu (nhất là phiếu nhập từ Lark) trước khi áp dụng. */
export const DATA_FIXUP_FIELDS = [
  'productName',
  'parentName',
  'middleName',
  'childName',
  'tradeMarkId',
  'unit',
  'netWeightGram',
  'misaCode',
  'description',
  'images',
];

export interface RuleTicket {
  stage: string;
  parentName?: string | null;
  createdById?: number | null;
  costApproverId?: number | null;
  sendToChiefAccountant?: boolean | null;
  chiefAccountantDecision?: string | null;
  ceoDecision?: string | null;
  productId?: number | null;
  [key: string]: unknown;
}

export interface RuleActor {
  id: number;
  isSuperAdmin: boolean;
  permissions: string[];
}

export type ApproverMap = Partial<Record<NppGroup, number[]>>;

export function normText(value?: string | null): string {
  return (value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isManufactured(
  ticket: Pick<RuleTicket, 'parentName'>,
): boolean {
  return normText(ticket.parentName) === normText(MANUFACTURED_PARENT);
}

export function isFinalStage(stage: string): boolean {
  return (FINAL_STAGES as string[]).includes(stage);
}

/** Chép công thức "Trạng thái" trên Lark. */
export function computeStatus(ticket: RuleTicket): NppStatus {
  const lateStages: string[] = [
    NPP_STAGE.SALES,
    NPP_STAGE.CEO,
    NPP_STAGE.DATA,
    NPP_STAGE.DONE,
  ];
  if (isManufactured(ticket) && lateStages.includes(ticket.stage)) {
    return NPP_STATUS.APPROVED;
  }
  if (
    ticket.chiefAccountantDecision === NPP_DECISION.REJECTED ||
    ticket.ceoDecision === NPP_DECISION.REJECTED
  ) {
    return NPP_STATUS.REJECTED;
  }
  if (ticket.ceoDecision === NPP_DECISION.APPROVED) return NPP_STATUS.APPROVED;
  return NPP_STATUS.UNDER_REVIEW;
}

/** Bước kế tiếp khi "Hoàn tất" bước hiện tại. Hàng sản xuất bỏ qua CEO. */
export function nextStage(ticket: RuleTicket): NppStage | null {
  switch (ticket.stage) {
    case NPP_STAGE.PROPOSAL:
      return NPP_STAGE.PURCHASING;
    case NPP_STAGE.PURCHASING:
      return NPP_STAGE.ACCOUNTING;
    case NPP_STAGE.ACCOUNTING:
      return NPP_STAGE.SALES;
    case NPP_STAGE.SALES:
      return isManufactured(ticket) ? NPP_STAGE.DATA : NPP_STAGE.CEO;
    case NPP_STAGE.CEO:
      return NPP_STAGE.DATA;
    case NPP_STAGE.DATA:
      return NPP_STAGE.DONE;
    default:
      return null;
  }
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Trường bắt buộc còn thiếu của bước (trả về key). */
export function missingRequired(ticket: RuleTicket, stage: string): string[] {
  const spec = STAGE_FIELDS[stage as NppStage];
  if (!spec) return [];
  return spec.required.filter((field) => isEmptyValue(ticket[field]));
}

/** Lý do chặn "Hoàn tất" bước hiện tại (null = được phép). */
export function completeBlockReason(ticket: RuleTicket): string | null {
  const missing = missingRequired(ticket, ticket.stage);
  if (missing.length > 0) {
    return `Còn thiếu: ${missing.map(fieldLabel).join(', ')}`;
  }
  if (
    ticket.stage === NPP_STAGE.ACCOUNTING &&
    ticket.sendToChiefAccountant &&
    ticket.chiefAccountantDecision !== NPP_DECISION.APPROVED
  ) {
    return ticket.chiefAccountantDecision === NPP_DECISION.REJECTED
      ? 'Kế toán trưởng đã từ chối giá vốn — sửa lại và gửi duyệt lại'
      : 'Đang chờ Kế toán trưởng duyệt giá vốn';
  }
  return null;
}

function inGroup(
  approvers: ApproverMap,
  group: NppGroup,
  userId: number,
): boolean {
  return (approvers[group] ?? []).includes(userId);
}

/** Người dùng có phải người xử lý của bước `stage` trên phiếu không. */
export function isStageActor(
  ticket: RuleTicket,
  stage: string,
  actor: RuleActor,
  approvers: ApproverMap,
): boolean {
  if (actor.isSuperAdmin) return true;
  if (stage === NPP_STAGE.PROPOSAL) return ticket.createdById === actor.id;
  if (stage === NPP_STAGE.PURCHASING) {
    return (
      inGroup(approvers, NPP_GROUP.PURCHASING, actor.id) ||
      ticket.costApproverId === actor.id
    );
  }
  const group = STAGE_GROUP[stage as NppStage];
  return group ? inGroup(approvers, group, actor.id) : false;
}

export interface TicketAccess {
  editableFields: string[];
  actions: NppAction[];
  isStageActor: boolean;
  completeBlockReason: string | null;
}

/** Trường sửa được + hành động được phép của một người trên phiếu. */
export function resolveAccess(
  ticket: RuleTicket,
  actor: RuleActor,
  approvers: ApproverMap,
): TicketAccess {
  const stage = ticket.stage;
  const actions: NppAction[] = [NPP_ACTION.COMMENT];
  if (isFinalStage(stage)) {
    return {
      editableFields: [],
      actions,
      isStageActor: false,
      completeBlockReason: null,
    };
  }

  const stageActor = isStageActor(ticket, stage, actor, approvers);
  const editable = new Set<string>();

  if (stageActor) {
    const spec = STAGE_FIELDS[stage as NppStage];
    if (spec)
      [...spec.required, ...spec.optional].forEach((f) => editable.add(f));
    COMMON_FIELDS.forEach((f) => editable.add(f));
    if (stage === NPP_STAGE.DATA && !ticket.productId) {
      DATA_FIXUP_FIELDS.forEach((f) => editable.add(f));
    }
  }

  // Mô tả / USP / Ứng dụng: người tạo hoặc Thu Mua nhập song song.
  if (
    PARALLEL_STAGES.includes(stage as NppStage) &&
    (ticket.createdById === actor.id ||
      isStageActor(ticket, NPP_STAGE.PURCHASING, actor, approvers))
  ) {
    PARALLEL_FIELDS.forEach((f) => editable.add(f));
  }

  // Super Admin sửa được trường của các bước đã qua để chữa sai sót.
  if (actor.isSuperAdmin) {
    for (const s of [
      NPP_STAGE.PROPOSAL,
      NPP_STAGE.PURCHASING,
      NPP_STAGE.ACCOUNTING,
      NPP_STAGE.SALES,
    ] as NppStage[]) {
      const spec = STAGE_FIELDS[s]!;
      [...spec.required, ...spec.optional].forEach((f) => editable.add(f));
      if (s === stage) break;
    }
  }

  const completable: string[] = [
    NPP_STAGE.PROPOSAL,
    NPP_STAGE.PURCHASING,
    NPP_STAGE.ACCOUNTING,
    NPP_STAGE.SALES,
  ];
  if (stageActor && completable.includes(stage)) {
    actions.push(NPP_ACTION.COMPLETE);
  }

  const sendBackable: string[] = [
    NPP_STAGE.ACCOUNTING,
    NPP_STAGE.SALES,
    NPP_STAGE.CEO,
    NPP_STAGE.DATA,
  ];
  if (stageActor && sendBackable.includes(stage) && !ticket.productId) {
    actions.push(NPP_ACTION.SEND_BACK);
  }

  if (stage === NPP_STAGE.ACCOUNTING) {
    const pending =
      !!ticket.sendToChiefAccountant && !ticket.chiefAccountantDecision;
    if (
      stageActor &&
      !pending &&
      ticket.chiefAccountantDecision !== NPP_DECISION.APPROVED
    ) {
      actions.push(NPP_ACTION.SEND_KTT);
    }
    if (
      pending &&
      (actor.isSuperAdmin ||
        inGroup(approvers, NPP_GROUP.CHIEF_ACCOUNTANT, actor.id))
    ) {
      actions.push(NPP_ACTION.KTT_DECIDE);
    }
  }

  if (stage === NPP_STAGE.CEO && stageActor)
    actions.push(NPP_ACTION.CEO_DECIDE);
  if (stage === NPP_STAGE.DATA && stageActor) actions.push(NPP_ACTION.APPLY);

  const earlyStages: string[] = [NPP_STAGE.PROPOSAL, NPP_STAGE.PURCHASING];
  if (
    actor.isSuperAdmin ||
    actor.permissions.includes(PERM.CONFIG) ||
    (ticket.createdById === actor.id && earlyStages.includes(stage))
  ) {
    if (!ticket.productId) actions.push(NPP_ACTION.END);
  }

  return {
    editableFields: [...editable],
    actions,
    isStageActor: stageActor,
    completeBlockReason: actions.includes(NPP_ACTION.COMPLETE)
      ? completeBlockReason(ticket)
      : null,
  };
}
