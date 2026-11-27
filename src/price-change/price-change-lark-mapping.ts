// Đọc bản ghi bảng Lark "Thay Đổi Giá Sản Phẩm" → dữ liệu phiếu (hàm thuần, có spec).
import {
  foldText,
  larkDecision,
  larkNumber,
} from '../new-product-price/new-product-price-lark-mapping';
import {
  BASE_PRICE_BOOK_ID,
  PC_DECISION,
  PC_STAGE,
  PcStage,
} from './price-change.constants';

export const FLOW_FIELD = 'Đề Xuất';
const COST_FIELD = /^gia von \((.+)\) muon doi$/;
const PRICE_FIELD = /^(bang gia .+?) muon doi$/;

export interface LarkCellValue {
  /** Tên chi nhánh / bảng giá đọc từ tên cột Lark. */
  name: string;
  value: number;
}

/** Quét các cột "Giá Vốn (X) Muốn Đổi" và "Bảng Giá X Muốn Đổi" có giá trị. */
export function extractLarkChanges(fields: Record<string, unknown>): {
  costs: LarkCellValue[];
  prices: LarkCellValue[];
} {
  const costs: LarkCellValue[] = [];
  const prices: LarkCellValue[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    const folded = foldText(key);
    const value = larkNumber(raw);
    if (value === null || value <= 0) continue;
    const cost = COST_FIELD.exec(folded);
    if (cost) {
      const m = /\((.+)\)/.exec(key);
      costs.push({ name: (m?.[1] ?? cost[1]).trim(), value });
      continue;
    }
    if (PRICE_FIELD.test(folded)) {
      prices.push({ name: key.replace(/\s*muốn đổi\s*$/i, '').trim(), value });
    }
  }
  return { costs, prices };
}

/** Khớp tên (không phân biệt dấu / hoa thường): bằng nhau, hoặc tên này chứa tên kia. */
export function matchByName<T extends { id: number; name: string }>(
  name: string,
  rows: T[],
): T | null {
  const f = foldText(name);
  if (!f) return null;
  const exact = rows.filter((r) => foldText(r.name) === f);
  if (exact.length === 1) return exact[0];
  const loose = rows.filter((r) => {
    const rf = foldText(r.name);
    return rf.includes(f) || f.includes(rf);
  });
  return loose.length === 1 ? loose[0] : null;
}

/** Bảng giá Lark → id bảng giá POS (0 = Bảng giá chung); null nếu không khớp. */
export function matchPriceBook(
  name: string,
  books: { id: number; name: string }[],
): number | null {
  if (foldText(name) === 'bang gia chung') return BASE_PRICE_BOOK_ID;
  return matchByName(name, books)?.id ?? null;
}

export interface StageInput {
  flow: string;
  hasCost: boolean;
  ktt: 'APPROVED' | 'REJECTED' | null;
  ceo: 'APPROVED' | 'REJECTED' | null;
}

/**
 * Trường Flow trên Lark hầu như không được chuyển bước (phiếu đã duyệt vẫn ở
 * "Đề xuất giá vốn") → suy bước từ quyết định duyệt. Phiếu CEO đã duyệt coi như
 * đã xong trên Lark (KHÔNG đưa vào Phòng Dữ Liệu để tránh áp lại giá cũ).
 */
export function inferStage(input: StageInput): PcStage {
  const flow = foldText(input.flow);
  if (flow === 'done' || flow.includes('hoan thanh')) return PC_STAGE.DONE;
  if (
    input.ktt === PC_DECISION.REJECTED ||
    input.ceo === PC_DECISION.REJECTED
  ) {
    return PC_STAGE.ENDED;
  }
  if (input.ceo === PC_DECISION.APPROVED) return PC_STAGE.DONE;
  if (input.ktt === PC_DECISION.APPROVED)
    return input.hasCost ? PC_STAGE.CEO : PC_STAGE.DATA;
  if (flow.includes('ke toan truong')) return PC_STAGE.CHIEF_ACCOUNTANT;
  if (flow.includes('ceo')) return PC_STAGE.CEO;
  if (flow.includes('du lieu')) return PC_STAGE.DATA;
  return PC_STAGE.PROPOSAL;
}

/** Quyết định CEO trên Lark: phiếu có giá vốn lấy "CEO Duyệt Giá Vốn", còn lại "CEO Duyệt Giá Bán". */
export function larkCeoDecision(
  fields: Record<string, unknown>,
  hasCost: boolean,
  get: (fields: Record<string, unknown>, ...names: string[]) => unknown,
): 'APPROVED' | 'REJECTED' | null {
  const cost = larkDecision(get(fields, 'CEO Duyệt Giá Vốn'));
  const sale = larkDecision(get(fields, 'CEO Duyệt Giá Bán'));
  if (cost === PC_DECISION.REJECTED || sale === PC_DECISION.REJECTED)
    return PC_DECISION.REJECTED;
  return hasCost ? (cost ?? sale) : (sale ?? cost);
}
