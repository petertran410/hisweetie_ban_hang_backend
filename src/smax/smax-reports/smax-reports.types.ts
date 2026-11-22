// Hợp đồng dữ liệu GET /reports/smax/summary (frontend: lib/dashboard/smax/smaxDashboard.types.ts).

/** Một chỉ số kèm kỳ trước; previous / changePct = null khi không có kỳ so sánh. */
export interface SmaxKpi {
  value: number;
  previous: number | null;
  /** % thay đổi so với kỳ trước (1 chữ số thập phân); null khi kỳ trước = 0. */
  changePct: number | null;
}

/** Chỉ số tỉ lệ (%), kèm tử số / mẫu số của kỳ này. */
export interface SmaxRateKpi extends SmaxKpi {
  num: number;
  den: number;
}

export interface SmaxKpis {
  /** Số nhân viên có gửi tin qua POS. */
  activeStaff: SmaxKpi;
  /** Số lượt gửi tin qua POS. */
  messages: SmaxKpi;
  /** Số lượt gắn hội thoại với khách POS (customer_zalo_contacts mới). */
  links: SmaxKpi;
  /** Độ phủ Zalo (%): khách có hoá đơn trong kỳ đã có liên hệ Zalo / khách có hoá đơn. */
  coverage: SmaxRateKpi;
  /** Lead có hội thoại tạo trong kỳ → đã chuyển đổi (%). num = đã chuyển đổi, den = lead có hội thoại. */
  leadConversion: SmaxRateKpi;
  /** Doanh thu hoá đơn của khách được chat, trong 7 ngày sau lần chat đầu trong kỳ. */
  chatRevenue: SmaxKpi & { customers: number; invoices: number };
  /** Tỉ lệ gửi lỗi (%): num = lượt lỗi / gửi thiếu phần, den = tổng lượt gửi. */
  failureRate: SmaxRateKpi;
}

/** Hội thoại theo Smax (đếm bằng API Smax, cache 10 phút). */
export interface SmaxThreadStats {
  /** false khi không có khoảng ngày hoặc Smax lỗi → `note` nói lý do. */
  available: boolean;
  note: string | null;
  /** Thread tạo trong kỳ. */
  newTotal: number;
  newGroup: number;
  newDirect: number;
  /** Thread tạo trước kỳ, có tin cuối trong kỳ (cách nới). */
  renewTotal: number;
  renewGroup: number;
  renewDirect: number;
  /** Kỳ kết thúc trước hôm nay → renew bị thiếu (thread có tin sau kỳ không tính). */
  partial: boolean;
}

export interface SmaxTrendPoint {
  /** YYYY-MM-DD (giờ VN). */
  key: string;
  /** dd/mm */
  label: string;
  messages: number;
  direct: number;
  group: number;
  links: number;
}

export interface SmaxFunnelStage {
  key: 'leads' | 'handedOver' | 'converted';
  label: string;
  value: number;
  /** % so với tầng đầu. */
  pct: number;
}

export interface SmaxSalesSupport {
  qr: number;
  productImages: number;
  packingSlips: number;
  deliveryBookings: number;
}

export interface SmaxStaffRow {
  userId: number;
  name: string;
  messages: number;
  direct: number;
  group: number;
  links: number;
  /** Khách POS được nhân viên này chat trong kỳ. */
  chattedCustomers: number;
  /** Trong số đó, có hoá đơn trong 7 ngày sau lần chat đầu. */
  customersWithOrder: number;
  revenue: number;
  failures: number;
}

export interface SmaxChannelRow {
  pagePid: string;
  name: string;
  platform: string;
  messages: number;
  direct: number;
  group: number;
  links: number;
  failures: number;
  /** null khi khối hội thoại không khả dụng. */
  newThreads: number | null;
  renewThreads: number | null;
}

export interface SmaxSendError {
  at: string;
  userName: string;
  channelName: string;
  /** Câu lỗi (không có nội dung tin nhắn). */
  error: string;
}

export interface SmaxDashboardData {
  period: { label: string; compareLabel: string | null };
  /** true = chỉ số liệu của chính người xem (không có quyền xem dữ liệu NV khác). */
  ownOnly: boolean;
  kpis: SmaxKpis;
  threads: SmaxThreadStats;
  trend: SmaxTrendPoint[];
  funnel: SmaxFunnelStage[];
  salesSupport: SmaxSalesSupport;
  staff: SmaxStaffRow[];
  channels: SmaxChannelRow[];
  errors: SmaxSendError[];
}

export interface SmaxFilterOptions {
  channels: { pagePid: string; name: string; platform: string }[];
  staff: { id: number; name: string }[];
  branches: { id: number; name: string }[];
}
