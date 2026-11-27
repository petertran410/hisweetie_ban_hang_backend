// Các cột công thức của Lark (không lưu DB). Bản sao phía FE:
// pos-hisweetie/lib/new-product-price/pricing.ts — sửa ở đây thì sửa cả bên đó.
import { VAT_DIVISOR } from './new-product-price.constants';

type NumLike = number | string | { toNumber(): number } | null | undefined;

export function toNum(value: NumLike): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

/** Bỏ trống hoặc = 0 coi như chưa có (giống IF(OR(ISBLANK, =0)) trên Lark). */
function present(value: NumLike): number | null {
  const n = toNum(value);
  return n === null || n === 0 ? null : n;
}

export interface PricingInput {
  goodsPrice?: NumLike;
  exchangeRate?: NumLike;
  cogsHn?: NumLike;
  cogsSg?: NumLike;
  cogsDt?: NumLike;
  priceHnRetail?: NumLike;
  priceHnWholesale?: NumLike;
  priceSgRetail?: NumLike;
  priceSgWholesale?: NumLike;
  priceDlcl?: NumLike;
  priceShopee?: NumLike;
  priceOem?: NumLike;
}

/** Giá hàng VNĐ = Giá hàng × Tỉ giá (hàng nội địa tỉ giá = 1). */
export function goodsPriceVnd(t: PricingInput): number | null {
  const price = toNum(t.goodsPrice);
  if (price === null) return null;
  const rate = toNum(t.exchangeRate) ?? 1;
  return Math.round(price * rate * 100) / 100;
}

export interface PriceAnalysisRow {
  key: string;
  label: string;
  price: number | null;
  /** Giá trước VAT (Shopee: giữ nguyên giá, như Lark). */
  priceExVat: number | null;
  /** Giá vốn so sánh (COGS trước VAT; Shopee dùng Giá vốn CH Diệp Trà). */
  cogs: number | null;
  profit: number | null;
  margin: number | null;
  basis: string;
}

function row(
  key: string,
  label: string,
  price: NumLike,
  cost: NumLike,
  opts: { exVat: boolean; basis: string },
): PriceAnalysisRow {
  const p = present(price);
  const c = present(cost);
  const priceExVat = p === null ? null : opts.exVat ? p / VAT_DIVISOR : p;
  const cogs = c === null ? null : opts.exVat ? c / VAT_DIVISOR : c;
  const profit =
    priceExVat !== null && cogs !== null ? priceExVat - cogs : null;
  const margin = profit !== null && cogs ? profit / cogs : null;
  return {
    key,
    label,
    price: p,
    priceExVat,
    cogs,
    profit,
    margin,
    basis: opts.basis,
  };
}

/**
 * Lợi nhuận / tỷ suất theo công thức Lark:
 *  - trước VAT = giá / 1.08, COGS = giá vốn / 1.08
 *  - lợi nhuận = giá trước VAT − COGS, tỷ suất = lợi nhuận / COGS
 *  - HN (Lẻ, Buôn, ĐLCL, OEM) theo giá vốn HN; SG (Lẻ, Buôn, ĐLCL) theo giá vốn SG
 *  - Shopee: Giá Shopee − Giá vốn CH Diệp Trà (không chia 1.08)
 */
export function priceAnalysis(t: PricingInput): PriceAnalysisRow[] {
  const hn = { exVat: true, basis: 'Giá vốn Hà Nội' };
  const sg = { exVat: true, basis: 'Giá vốn Sài Gòn' };
  return [
    row('HN_RETAIL', 'HN - Giá Lẻ', t.priceHnRetail, t.cogsHn, hn),
    row('HN_WHOLESALE', 'HN - Giá Buôn', t.priceHnWholesale, t.cogsHn, hn),
    row('HN_DLCL', 'HN - Giá ĐLCL', t.priceDlcl, t.cogsHn, hn),
    row('SG_RETAIL', 'SG - Giá Lẻ', t.priceSgRetail, t.cogsSg, sg),
    row('SG_WHOLESALE', 'SG - Giá Buôn', t.priceSgWholesale, t.cogsSg, sg),
    row('SG_DLCL', 'SG - Giá ĐLCL', t.priceDlcl, t.cogsSg, sg),
    row('OEM', 'Giá OEM', t.priceOem, t.cogsHn, hn),
    row('SHOPEE', 'Giá Shopee', t.priceShopee, t.cogsDt, {
      exVat: false,
      basis: 'Giá vốn CH Diệp Trà',
    }),
  ];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Leadtime (ngày) = từ lúc tạo đến khi hoàn thành/kết thúc (chưa xong → tới hôm nay). */
export function leadtimeDays(
  t: { createdAt: Date; doneAt?: Date | null; endedAt?: Date | null },
  now: Date = new Date(),
): number {
  const end = t.doneAt ?? t.endedAt ?? now;
  return Math.max(
    0,
    Math.floor((end.getTime() - t.createdAt.getTime()) / DAY_MS),
  );
}
