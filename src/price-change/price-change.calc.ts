// Chênh lệch giá cũ → mới, cùng công thức cột "So với giá cũ" / "Tỷ lệ" trên Lark.
import { Prisma } from '@prisma/client';
import type { CostLine, PriceLine } from './price-change.constants';

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n =
    value instanceof Prisma.Decimal ? value.toNumber() : Number(value as any);
  return Number.isFinite(n) ? n : null;
}

export interface CellDiff {
  diff: number | null;
  /** (mới − cũ) / cũ; null khi chưa có giá cũ hoặc giá cũ = 0. */
  ratio: number | null;
}

export function cellDiff(oldValue: unknown, newValue: unknown): CellDiff {
  const o = toNum(oldValue);
  const n = toNum(newValue);
  if (n === null || o === null) return { diff: null, ratio: null };
  return { diff: n - o, ratio: o === 0 ? null : (n - o) / o };
}

export interface ItemLike {
  costs: CostLine[];
  prices: PriceLine[];
}

export interface TicketSummary {
  productCount: number;
  costCells: number;
  priceCells: number;
  increases: number;
  decreases: number;
}

/** Đếm số ô có giá mới và số ô tăng / giảm của cả phiếu. */
export function summarizeItems(items: ItemLike[]): TicketSummary {
  const out: TicketSummary = {
    productCount: items.length,
    costCells: 0,
    priceCells: 0,
    increases: 0,
    decreases: 0,
  };
  const count = (oldV: number | null, newV: number | null) => {
    const { diff } = cellDiff(oldV, newV);
    if (diff === null) return;
    if (diff > 0) out.increases++;
    else if (diff < 0) out.decreases++;
  };
  for (const item of items) {
    for (const c of item.costs) {
      if (c.newCost === null) continue;
      out.costCells++;
      count(c.oldCost, c.newCost);
    }
    for (const p of item.prices) {
      if (p.newPrice === null) continue;
      out.priceCells++;
      count(p.oldPrice, p.newPrice);
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Số ngày tròn từ `from` tới `now` (≥ 0) — số ngày phiếu đã chờ ở bước hiện tại. */
export function daysSince(from: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}
