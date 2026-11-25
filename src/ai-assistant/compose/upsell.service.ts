import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiComposeService, type ComposeActor } from './ai-compose.service';

const DAY_MS = 86_400_000;
/** Chu kỳ mua tính trên hoá đơn 12 tháng (user chốt). */
const HISTORY_DAYS = 365;
/** Mua kèm: thống kê hoá đơn toàn công ty 90 ngày, làm mới mỗi ngày. */
const BASKET_DAYS = 90;
const BASKET_TTL_MS = 24 * 3_600_000;
/** Khách đi nhà xe: có báo đơn phí gửi bến trong 90 ngày. */
const COACH_DAYS = 90;
/** Món mua ít nhất chừng này lần (khác ngày) mới tính chu kỳ. */
const MIN_PURCHASES = 3;
/** Trễ khi quá 1,2 lần chu kỳ. */
const OVERDUE_FACTOR = 1.2;
/**
 * Món trễ quá lâu (quá 4 lần chu kỳ hoặc quá 120 ngày) coi như khách đã bỏ / đổi hãng → không gợi ý
 * "đặt lại" (tối thiểu vẫn xét 30 ngày cho món chu kỳ ngắn).
 */
const MAX_CYCLES_LATE = 4;
const MAX_DAYS_LATE = 120;
const MIN_WINDOW_DAYS = 30;
/** Cặp mua kèm phải xuất hiện cùng nhau ở ít nhất chừng này hoá đơn, và ≥ 10% đơn của món mốc. */
const MIN_SUPPORT = 5;
const MIN_CONFIDENCE = 0.1;
const LIMIT = 5;

type Product = {
  id: number;
  code: string;
  name: string;
  unit: string | null;
  cargoType: string | null;
};

export type ReorderItem = {
  productId: number;
  code: string;
  name: string;
  unit: string | null;
  lastDate: string;
  cycleDays: number;
  daysSince: number;
  overdueDays: number;
  times: number;
  price: number | null;
  priceSource: string | null;
};

export type TogetherItem = {
  productId: number;
  code: string;
  name: string;
  unit: string | null;
  /** Món khách hay mua đi kèm với món này. */
  withName: string;
  /** % hoá đơn có món khách mua cũng có món này. */
  confidence: number;
  price: number | null;
  priceSource: string | null;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Ngày (theo giờ VN) dạng YYYY-MM-DD. */
const vnDay = (d: Date) =>
  new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Lâu chưa đặt lại: mỗi món khách mua ≥ 3 ngày khác nhau trong 12 tháng → chu kỳ = trung vị khoảng
 * cách giữa các lần; trễ khi đã quá 1,2 lần chu kỳ. Xếp theo mức trễ so với chu kỳ.
 */
export function overdueItems(
  purchases: { productId: number; date: Date }[],
  now: Date,
): {
  productId: number;
  lastDate: string;
  cycleDays: number;
  daysSince: number;
  times: number;
}[] {
  const days = new Map<number, Set<string>>();
  for (const p of purchases) {
    const set = days.get(p.productId) ?? new Set<string>();
    set.add(vnDay(p.date));
    days.set(p.productId, set);
  }
  const today = Date.parse(vnDay(now));
  const out: {
    productId: number;
    lastDate: string;
    cycleDays: number;
    daysSince: number;
    times: number;
    ratio: number;
  }[] = [];
  for (const [productId, set] of days) {
    if (set.size < MIN_PURCHASES) continue;
    const sorted = [...set].sort();
    const stamps = sorted.map((d) => Date.parse(d));
    const gaps = stamps.slice(1).map((t, i) => (t - stamps[i]) / DAY_MS);
    const cycleDays = Math.max(1, Math.round(median(gaps)));
    const daysSince = Math.round((today - stamps[stamps.length - 1]) / DAY_MS);
    if (daysSince <= cycleDays * OVERDUE_FACTOR) continue;
    const window = Math.min(
      MAX_DAYS_LATE,
      Math.max(MIN_WINDOW_DAYS, cycleDays * MAX_CYCLES_LATE),
    );
    if (daysSince > window) continue;
    out.push({
      productId,
      lastDate: sorted[sorted.length - 1],
      cycleDays,
      daysSince,
      times: set.size,
      ratio: daysSince / cycleDays,
    });
  }
  return out
    .sort((a, b) => b.ratio - a.ratio)
    .map((item) => ({
      productId: item.productId,
      lastDate: item.lastDate,
      cycleDays: item.cycleDays,
      daysSince: item.daysSince,
      times: item.times,
    }));
}

/**
 * Hay mua kèm: với các món khách mua nhiều nhất, tìm món thường nằm cùng hoá đơn (toàn công ty,
 * 90 ngày) mà khách chưa mua trong 12 tháng. Xếp theo lift (tần suất đi kèm so với tần suất chung).
 */
export function togetherItems(
  baskets: ReadonlyMap<number, ReadonlySet<number>>,
  anchors: number[],
  owned: ReadonlySet<number>,
): { productId: number; withId: number; confidence: number; lift: number }[] {
  const total = baskets.size;
  if (!total) return [];
  const freq = new Map<number, number>();
  for (const items of baskets.values())
    for (const id of items) freq.set(id, (freq.get(id) ?? 0) + 1);
  const best = new Map<
    number,
    { productId: number; withId: number; confidence: number; lift: number }
  >();
  for (const anchor of anchors) {
    const pair = new Map<number, number>();
    let anchorCount = 0;
    for (const items of baskets.values()) {
      if (!items.has(anchor)) continue;
      anchorCount += 1;
      for (const id of items)
        if (id !== anchor && !owned.has(id))
          pair.set(id, (pair.get(id) ?? 0) + 1);
    }
    if (!anchorCount) continue;
    for (const [id, count] of pair) {
      const confidence = count / anchorCount;
      if (count < MIN_SUPPORT || confidence < MIN_CONFIDENCE) continue;
      const lift = confidence / ((freq.get(id) ?? 1) / total);
      const current = best.get(id);
      if (lift > 1.5 && (!current || lift > current.lift))
        best.set(id, { productId: id, withId: anchor, confidence, lift });
    }
  }
  return [...best.values()].sort((a, b) => b.lift - a.lift);
}

/** Gợi ý bán thêm cho khách đang chat (thống kê hoá đơn, không gọi AI). */
@Injectable()
export class UpsellService {
  private baskets: {
    at: number;
    data: Promise<Map<number, Set<number>>>;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly compose: AiComposeService,
  ) {}

  async forCustomer(actor: ComposeActor, customerId: number, now = new Date()) {
    const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
    const [lines, viaCoach, baskets] = await Promise.all([
      this.prisma.invoiceDetail.findMany({
        where: {
          productId: { not: null },
          isGift: false,
          lineType: 'normal',
          invoice: {
            customerId,
            status: { not: 2 },
            purchaseDate: { gte: since },
          },
        },
        select: {
          productId: true,
          invoice: { select: { purchaseDate: true } },
        },
      }),
      this.viaCoach(customerId, now),
      this.loadBaskets(now),
    ]);
    const purchases = lines.map((l) => ({
      productId: l.productId!,
      date: l.invoice.purchaseDate,
    }));
    const owned = new Set(purchases.map((p) => p.productId));
    // Món khách mua nhiều nhất (theo số hoá đơn) làm mốc tìm món đi kèm
    const counts = new Map<number, number>();
    for (const p of purchases)
      counts.set(p.productId, (counts.get(p.productId) ?? 0) + 1);
    const anchors = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id]) => id);

    const due = overdueItems(purchases, now);
    const together = togetherItems(baskets, anchors, owned);
    const ids = [
      ...new Set([
        ...due.map((d) => d.productId),
        ...together.map((t) => t.productId),
        ...together.map((t) => t.withId),
      ]),
    ];
    const products = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            code: true,
            name: true,
            unit: true,
            cargoType: true,
            isActive: true,
            isDirectSale: true,
          },
        })
      ).map((p) => [p.id, p]),
    );
    // Chỉ hàng đang bán trực tiếp; khách đi nhà xe → không gợi ý hàng lạnh
    const sellable = (id: number) => {
      const p = products.get(id);
      return (
        !!p &&
        p.isActive &&
        p.isDirectSale &&
        !(viaCoach && p.cargoType === 'COLD')
      );
    };
    const reorder = due.filter((d) => sellable(d.productId)).slice(0, LIMIT);
    const extra = together.filter((t) => sellable(t.productId)).slice(0, LIMIT);
    const prices = await this.compose.suggestedPrices(actor, customerId, [
      ...reorder.map((r) => r.productId),
      ...extra.map((t) => t.productId),
    ]);
    const info = (id: number) => {
      const p = products.get(id) as Product;
      const price = prices.get(id);
      return {
        productId: id,
        code: p.code,
        name: p.name,
        unit: p.unit,
        // Giá 0 (chưa đặt giá) → không hiện
        price: price?.price ? price.price : null,
        priceSource: price?.source ?? null,
      };
    };
    return {
      viaCoach,
      historyMonths: 12,
      reorder: reorder.map(
        (r): ReorderItem => ({
          ...info(r.productId),
          lastDate: r.lastDate,
          cycleDays: r.cycleDays,
          daysSince: r.daysSince,
          overdueDays: r.daysSince - r.cycleDays,
          times: r.times,
        }),
      ),
      together: extra.map(
        (t): TogetherItem => ({
          ...info(t.productId),
          withName: products.get(t.withId)?.name ?? '',
          confidence: Math.round(t.confidence * 100),
        }),
      ),
    };
  }

  /** Khách nhận hàng qua nhà xe: báo đơn 90 ngày có phí gửi bến. */
  private async viaCoach(customerId: number, now: Date) {
    const found = await this.prisma.packingSlip.findFirst({
      where: {
        createdAt: { gte: new Date(now.getTime() - COACH_DAYS * DAY_MS) },
        feeGuiBen: { gt: 0 },
        invoices: { some: { invoice: { customerId } } },
      },
      select: { id: true },
    });
    return !!found;
  }

  /** Hoá đơn 90 ngày toàn công ty → tập sản phẩm mỗi hoá đơn (cache 24 giờ). */
  private loadBaskets(now: Date) {
    if (!this.baskets || now.getTime() - this.baskets.at > BASKET_TTL_MS) {
      const data = this.prisma.invoiceDetail
        .findMany({
          where: {
            productId: { not: null },
            isGift: false,
            lineType: 'normal',
            invoice: {
              status: { not: 2 },
              purchaseDate: {
                gte: new Date(now.getTime() - BASKET_DAYS * DAY_MS),
              },
            },
          },
          select: { invoiceId: true, productId: true },
        })
        .then((rows) => {
          const map = new Map<number, Set<number>>();
          for (const r of rows) {
            const set = map.get(r.invoiceId) ?? new Set<number>();
            set.add(r.productId!);
            map.set(r.invoiceId, set);
          }
          return map;
        });
      this.baskets = { at: now.getTime(), data };
      data.catch(() => (this.baskets = null));
    }
    return this.baskets.data;
  }
}
