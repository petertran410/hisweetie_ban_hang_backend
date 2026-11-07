// Kiểu response của GET /reports/leads/summary — khớp hợp đồng ở frontend
// pos-hisweetie/lib/dashboard/lead/leadDashboard.types.ts (sửa một bên thì sửa cả bên kia).

import type { HandoverStep } from '../leads.constants';

export type LeadGranularity = 'day' | 'week' | 'month';

export interface LeadKpi {
  value: number;
  previous: number;
  changePct: number | null;
}

/** Chỉ số thời gian: null khi chưa có lead nào đủ điều kiện để tính. */
export interface LeadDurationKpi {
  value: number | null;
  previous: number | null;
  changePct: number | null;
}

export interface LeadKpis {
  total: LeadKpi;
  newLeads: LeadKpi;
  caring: LeadKpi;
  handedOver: LeadKpi;
  converted: LeadKpi;
  /** % = đã chuyển đổi / (tổng lead − huỷ). */
  conversionRate: LeadKpi & {
    /** Tham khảo: đã chuyển đổi / tổng lead (kể cả huỷ). */
    rateOfAllLeads: number;
  };
  avgHoursToHandover: LeadDurationKpi;
  avgHoursToFirstOrder: LeadDurationKpi;
}

export type LeadFunnelStageKey =
  | 'lead'
  | 'caring'
  | 'handed_over'
  | 'has_customer'
  | 'ordered';

export interface LeadFunnelStage {
  key: LeadFunnelStageKey;
  label: string;
  count: number;
  pctOfTop: number;
  dropPct: number | null;
  dropCount: number | null;
}

export interface LeadSourceRow {
  source: string;
  leads: number;
  converted: number;
  conversionRate: number;
  sharePct: number;
  previousLeads: number;
  leadsChangePct: number | null;
}

export interface LeadCskhRow {
  /** 0 = lead chưa gán CSKH. */
  userId: number;
  name: string;
  received: number;
  cared: number;
  handedOver: number;
  converted: number;
  conversionRate: number;
  avgFirstResponseMinutes: number | null;
  overdueNew: number;
}

export interface LeadSalePicRow {
  userId: number;
  name: string;
  received: number;
  withCustomer: number;
  ordered: number;
  conversionRate: number;
  avgDaysToFirstOrder: number | null;
  overdueNoOrder: number;
}

export interface LeadTrendPoint {
  key: string;
  label: string;
  newLeads: number;
  converted: number;
}

export type LeadTrend = Record<LeadGranularity, LeadTrendPoint[]>;

export interface LeadAttentionBase {
  leadId: number;
  name: string;
  source: string;
}

export interface LeadStaleNewItem extends LeadAttentionBase {
  createdAt: string;
  hoursOpen: number;
  cskhName: string | null;
}

export interface LeadHandoverErrorItem extends LeadAttentionBase {
  handoverId: number;
  failedStep: HandoverStep;
  error: string;
  at: string;
  salePicName: string | null;
  createdByName: string | null;
}

export interface LeadStaleHandedItem extends LeadAttentionBase {
  handedAt: string;
  daysSinceHandover: number;
  hasCustomer: boolean;
  salePicName: string | null;
}

export interface LeadAttentionList<T> {
  total: number;
  items: T[];
}

export interface LeadAttention {
  staleNew: LeadAttentionList<LeadStaleNewItem>;
  handoverErrors: LeadAttentionList<LeadHandoverErrorItem>;
  staleHanded: LeadAttentionList<LeadStaleHandedItem>;
}

export interface LeadDashboardData {
  period: {
    from: string | null;
    to: string | null;
    label: string;
    /** null khi không có kỳ trước để so (Toàn thời gian). */
    compareLabel: string | null;
  };
  asOf: string;
  kpis: LeadKpis;
  funnel: LeadFunnelStage[];
  bySource: LeadSourceRow[];
  cskh: LeadCskhRow[];
  salePic: LeadSalePicRow[];
  trend: LeadTrend;
  attention: LeadAttention;
}

export interface LeadFilterOptions {
  cskh: { id: number; name: string }[];
  salePics: { id: number; name: string }[];
}
