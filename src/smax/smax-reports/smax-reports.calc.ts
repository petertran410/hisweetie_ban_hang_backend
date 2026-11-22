// Phần tính thuần của báo cáo Smax chat (không gọi DB / Smax) — để test bằng jest.
// Service đếm bằng SQL rồi đưa kết quả vào đây để ráp response.

import {
  changePct,
  ratePct,
  type DateRange,
} from '../../leads/lead-reports/lead-reports.calc';
import type {
  SmaxChannelRow,
  SmaxFunnelStage,
  SmaxKpi,
  SmaxRateKpi,
  SmaxStaffRow,
  SmaxThreadStats,
  SmaxTrendPoint,
} from './smax-reports.types';

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
/** Chat → Đơn: tính hoá đơn trong chừng này ngày sau lần chat đầu trong kỳ. */
export const CHAT_ORDER_DAYS = 7;

export const csv = (v?: string) =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

export const csvInts = (v?: string) =>
  csv(v)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

/** YYYY-MM-DD theo giờ VN. */
export const vnDayKey = (d: Date) =>
  new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

/** 00:00 giờ VN của ngày chứa `d`. */
export const vnStartOfDay = (d: Date) =>
  new Date(`${vnDayKey(d)}T00:00:00+07:00`);

export function kpi(value: number, previous: number | null): SmaxKpi {
  return { value, previous, changePct: changePct(value, previous) };
}

/** Chỉ số tỉ lệ %; kỳ trước = null khi không có kỳ so sánh. */
export function rateKpi(
  num: number,
  den: number,
  prev: { num: number; den: number } | null,
): SmaxRateKpi {
  const value = ratePct(num, den);
  const previous = prev ? ratePct(prev.num, prev.den) : null;
  return {
    value,
    previous,
    changePct: changePct(value, previous),
    num,
    den,
  };
}

/** Số liệu theo ngày (giờ VN), điền 0 cho ngày trống để đường không đứt. */
export function buildTrend(
  sends: { day: string; messages: number; group: number }[],
  links: { day: string; n: number }[],
  range: DateRange | null,
  asOf: Date,
): SmaxTrendPoint[] {
  const days = [...sends.map((s) => s.day), ...links.map((l) => l.day)];
  if (!days.length && !range) return [];
  const first = range ? vnDayKey(range.from) : days.sort()[0];
  const endDate = range && range.to < asOf ? range.to : asOf;
  const last = vnDayKey(endDate);

  const byDay = new Map<string, SmaxTrendPoint>();
  const point = (key: string) => {
    let p = byDay.get(key);
    if (!p) {
      p = {
        key,
        label: `${key.slice(8, 10)}/${key.slice(5, 7)}`,
        messages: 0,
        direct: 0,
        group: 0,
        links: 0,
      };
      byDay.set(key, p);
    }
    return p;
  };
  for (
    let t = Date.parse(`${first}T00:00:00Z`);
    t <= Date.parse(`${last}T00:00:00Z`);
    t += DAY_MS
  )
    point(new Date(t).toISOString().slice(0, 10));
  for (const s of sends) {
    if (s.day < first || s.day > last) continue;
    const p = point(s.day);
    p.messages += s.messages;
    p.group += s.group;
    p.direct += s.messages - s.group;
  }
  for (const l of links) {
    if (l.day < first || l.day > last) continue;
    point(l.day).links += l.n;
  }
  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Phễu lead có hội thoại → đã chuyển Sale → đã chuyển đổi. */
export function buildFunnel(c: {
  leads: number;
  handedOver: number;
  converted: number;
}): SmaxFunnelStage[] {
  const pct = (n: number) => ratePct(n, c.leads);
  return [
    {
      key: 'leads',
      label: 'Lead có hội thoại',
      value: c.leads,
      pct: c.leads ? 100 : 0,
    },
    {
      key: 'handedOver',
      label: 'Đã chuyển Sale',
      value: c.handedOver,
      pct: pct(c.handedOver),
    },
    {
      key: 'converted',
      label: 'Đã chuyển đổi',
      value: c.converted,
      pct: pct(c.converted),
    },
  ];
}

/** Một dòng gửi tin đã gộp (nhân viên × kênh × ngày) từ SQL. */
export interface SendAgg {
  userId: number;
  userName: string;
  pagePid: string;
  day: string;
  messages: number;
  group: number;
  failures: number;
}

export interface LinkAgg {
  userId: number | null;
  pagePid: string | null;
  day: string;
  n: number;
}

/** Bảng theo nhân viên, sắp theo số tin giảm dần. */
export function buildStaffRows(
  sends: SendAgg[],
  links: LinkAgg[],
  orders: {
    userId: number;
    chattedCustomers: number;
    customersWithOrder: number;
    revenue: number;
  }[],
  userNames: Map<number, string>,
): SmaxStaffRow[] {
  const rows = new Map<number, SmaxStaffRow>();
  const row = (userId: number, name?: string) => {
    let r = rows.get(userId);
    if (!r) {
      r = {
        userId,
        name: name || userNames.get(userId) || `#${userId}`,
        messages: 0,
        direct: 0,
        group: 0,
        links: 0,
        chattedCustomers: 0,
        customersWithOrder: 0,
        revenue: 0,
        failures: 0,
      };
      rows.set(userId, r);
    }
    return r;
  };
  for (const s of sends) {
    const r = row(s.userId, s.userName);
    r.messages += s.messages;
    r.group += s.group;
    r.direct += s.messages - s.group;
    r.failures += s.failures;
  }
  for (const l of links) if (l.userId) row(l.userId).links += l.n;
  for (const o of orders) {
    const r = row(o.userId);
    r.chattedCustomers = o.chattedCustomers;
    r.customersWithOrder = o.customersWithOrder;
    r.revenue = o.revenue;
  }
  return [...rows.values()].sort(
    (a, b) => b.messages - a.messages || b.links - a.links,
  );
}

/** Bảng theo kênh; kênh không còn trên Smax vẫn giữ (tên = page_pid). */
export function buildChannelRows(
  sends: SendAgg[],
  links: LinkAgg[],
  channels: { pagePid: string; name: string; platform: string }[],
  threads: Map<string, { newTotal: number; renewTotal: number }> | null,
): SmaxChannelRow[] {
  const info = new Map(channels.map((c) => [c.pagePid, c]));
  const rows = new Map<string, SmaxChannelRow>();
  const row = (pagePid: string) => {
    let r = rows.get(pagePid);
    if (!r) {
      const c = info.get(pagePid);
      const t = threads?.get(pagePid);
      r = {
        pagePid,
        name: c?.name ?? pagePid,
        platform: c?.platform ?? '',
        messages: 0,
        direct: 0,
        group: 0,
        links: 0,
        failures: 0,
        newThreads: t ? t.newTotal : null,
        renewThreads: t ? t.renewTotal : null,
      };
      rows.set(pagePid, r);
    }
    return r;
  };
  for (const s of sends) {
    if (!s.pagePid) continue;
    const r = row(s.pagePid);
    r.messages += s.messages;
    r.group += s.group;
    r.direct += s.messages - s.group;
    r.failures += s.failures;
  }
  for (const l of links) if (l.pagePid) row(l.pagePid).links += l.n;
  // Kênh chưa có tin / lượt gắn nhưng có hội thoại trên Smax
  if (threads)
    for (const [pid, t] of threads) if (t.newTotal || t.renewTotal) row(pid);
  return [...rows.values()].sort(
    (a, b) =>
      b.messages - a.messages ||
      (b.newThreads ?? 0) - (a.newThreads ?? 0) ||
      a.name.localeCompare(b.name, 'vi'),
  );
}

/** Số đếm hội thoại của 1 kênh từ Smax. */
export interface ChannelThreadCounts {
  pagePid: string;
  created: number;
  createdGroup: number;
  active: number;
  activeGroup: number;
}

/**
 * New = tạo trong kỳ; Renew (cách nới) = có tin cuối trong kỳ nhưng tạo trước kỳ
 * = active − created (không âm). Trực tiếp = tổng − nhóm.
 */
export function buildThreadStats(
  counts: ChannelThreadCounts[],
  partial: boolean,
): {
  stats: SmaxThreadStats;
  byChannel: Map<string, { newTotal: number; renewTotal: number }>;
} {
  const byChannel = new Map<string, { newTotal: number; renewTotal: number }>();
  let newTotal = 0;
  let newGroup = 0;
  let renewTotal = 0;
  let renewGroup = 0;
  for (const c of counts) {
    const renew = Math.max(0, c.active - c.created);
    const renewG = Math.max(0, c.activeGroup - c.createdGroup);
    newTotal += c.created;
    newGroup += c.createdGroup;
    renewTotal += renew;
    renewGroup += Math.min(renewG, renew);
    byChannel.set(c.pagePid, { newTotal: c.created, renewTotal: renew });
  }
  return {
    stats: {
      available: true,
      note: null,
      newTotal,
      newGroup,
      newDirect: Math.max(0, newTotal - newGroup),
      renewTotal,
      renewGroup,
      renewDirect: Math.max(0, renewTotal - renewGroup),
      partial,
    },
    byChannel,
  };
}

export const unavailableThreads = (note: string): SmaxThreadStats => ({
  available: false,
  note,
  newTotal: 0,
  newGroup: 0,
  newDirect: 0,
  renewTotal: 0,
  renewGroup: 0,
  renewDirect: 0,
  partial: false,
});
