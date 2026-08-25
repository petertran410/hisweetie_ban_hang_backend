/**
 * Phân tích độ ổn định của doanh số để biết con số dự báo đáng tin đến đâu.
 *
 * Cách làm theo đúng quy trình nghiệp vụ mô tả:
 *
 *   1. Chia doanh số thành các tháng.
 *   2. Nhìn 3 tháng gần nhất. Nếu có tháng bán vọt lên hoặc tụt hẳn so với
 *      các tháng còn lại → đó là **biến số**, phải truy nguyên nhân.
 *   3. Với tháng bất thường: đối chiếu lịch khuyến mãi. Có KM → đột biến giải
 *      thích được, loại nó khỏi mức nền. Không có KM → nghi trend, cảnh báo
 *      để người mua tự quyết.
 *   4. Nếu 3 tháng gần nhất đều bình thường → nới ra 6 tháng để lấy mức nền
 *      chắc chắn hơn.
 *
 * Đầu ra không phải một con số dự báo, mà là **mức nền + mức độ dao động**.
 * Dao động chính là căn cứ tính tồn dự phòng: SKU bán đều thì đệm ít, SKU
 * tháng cao tháng thấp thì phải đệm nhiều.
 */

export interface MonthlySales {
  /** `YYYY-MM` */
  month: string;
  quantity: number;
  /** Số ngày có dữ liệu trong tháng — tháng đang chạy dở sẽ ít hơn. */
  days: number;
}

export interface PromotionWindow {
  startDate: Date;
  endDate: Date;
  name?: string | null;
}

export type MonthAnomaly = 'SPIKE' | 'DROP' | 'NORMAL';

export interface MonthAssessment {
  month: string;
  dailyRate: number;
  anomaly: MonthAnomaly;
  /** Tỉ lệ so với mức nền của các tháng bình thường. */
  ratio: number;
  hasPromotion: boolean;
  promotionNames: string[];
  /** Bất thường mà không có khuyến mãi giải thích → nghi trend. */
  suspectedTrend: boolean;
}

export type DemandStability = 'STABLE' | 'VOLATILE' | 'INSUFFICIENT_DATA';

export interface StabilityResult {
  /** Nhu cầu nền theo ngày, đã loại các tháng đột biến do khuyến mãi. */
  baselineDailyDemand: number;
  stability: DemandStability;
  /** Hệ số biến thiên (độ lệch chuẩn / trung bình) của các tháng bình thường. */
  variationCoefficient: number;
  /** Số tháng đã dùng để chốt mức nền: 3 hoặc 6. */
  monthsUsed: number;
  months: MonthAssessment[];
  /** Tháng bất thường không giải thích được bằng khuyến mãi. */
  trendMonths: string[];
  /** Tháng bất thường đã giải thích được bằng khuyến mãi. */
  promotionMonths: string[];
}

/** Vượt ngưỡng này so với mức nền thì coi là bán vọt. */
const SPIKE_THRESHOLD = 1.4;
/** Thấp hơn ngưỡng này thì coi là bán tụt. */
const DROP_THRESHOLD = 0.6;
/** Hệ số biến thiên vượt mức này thì coi doanh số là thất thường. */
const VOLATILE_CV = 0.35;

/**
 * Đánh giá độ ổn định và chốt mức nhu cầu nền.
 *
 * @param months Doanh số theo tháng, sắp xếp cũ → mới.
 * @param promotions Các đợt khuyến mãi để đối chiếu nguyên nhân đột biến.
 */
export function analyzeDemandStability(
  months: MonthlySales[],
  promotions: PromotionWindow[] = [],
): StabilityResult {
  const usable = months.filter((month) => month.days > 0);

  if (usable.length < 2) {
    return {
      baselineDailyDemand: usable[0] ? rate(usable[0]) : 0,
      stability: 'INSUFFICIENT_DATA',
      variationCoefficient: 0,
      monthsUsed: usable.length,
      months: usable.map((month) => ({
        month: month.month,
        dailyRate: rate(month),
        anomaly: 'NORMAL' as const,
        ratio: 1,
        hasPromotion: false,
        promotionNames: [],
        suspectedTrend: false,
      })),
      trendMonths: [],
      promotionMonths: [],
    };
  }

  // Bước 1-3: soi 3 tháng gần nhất trước.
  const recent = usable.slice(-3);
  const recentAssessment = assess(recent, promotions);
  const recentHasAnomaly = recentAssessment.some(
    (month) => month.anomaly !== 'NORMAL',
  );

  // Bước 4: 3 tháng gần nhất đều bình thường → nới ra 6 tháng cho chắc.
  const window =
    !recentHasAnomaly && usable.length > 3 ? usable.slice(-6) : recent;
  const assessments = assess(window, promotions);

  // Mức nền chỉ tính trên tháng bình thường và tháng đột biến do khuyến mãi
  // đã được giải thích — giữ lại tháng nghi trend sẽ kéo lệch con số nền.
  const baseMonths = assessments.filter(
    (month) => month.anomaly === 'NORMAL' || month.hasPromotion,
  );
  const baseRates = (baseMonths.length > 0 ? baseMonths : assessments).map(
    (month) => month.dailyRate,
  );

  const baseline = mean(baseRates);
  const cv = coefficientOfVariation(assessments.map((m) => m.dailyRate));

  return {
    baselineDailyDemand: round(baseline),
    stability: cv > VOLATILE_CV ? 'VOLATILE' : 'STABLE',
    variationCoefficient: round(cv),
    monthsUsed: window.length,
    months: assessments,
    trendMonths: assessments
      .filter((month) => month.suspectedTrend)
      .map((month) => month.month),
    promotionMonths: assessments
      .filter((month) => month.anomaly !== 'NORMAL' && month.hasPromotion)
      .map((month) => month.month),
  };
}

/**
 * Số ngày tồn dự phòng suy từ độ dao động thực tế thay vì một hằng số.
 *
 * Doanh số càng thất thường thì càng cần đệm dày, vì sai số dự báo lớn hơn.
 * Nhân với leadtime: chờ hàng càng lâu thì cùng một mức dao động sẽ gây thiệt
 * hại càng lớn.
 */
export function safetyDaysFromStability(
  result: StabilityResult,
  leadTimeDays: number,
): number {
  // Thiếu dữ liệu thì không đoán mức dao động — dùng đệm mặc định vừa phải.
  if (result.stability === 'INSUFFICIENT_DATA') {
    return Math.max(7, Math.round(leadTimeDays * 0.25));
  }

  // Hệ số biến thiên nhân căn bậc hai của leadtime là cách tính đệm an toàn
  // tiêu chuẩn trong quản trị tồn kho: sai số tích luỹ theo căn của thời gian
  // chứ không tuyến tính.
  //
  // Cố ý KHÔNG cộng thêm gì cho tháng nghi trend: trend là thông tin để người
  // mua đọc và tự quyết, không phải cái cớ để hệ thống âm thầm đội tồn lên.
  // Bản thân tháng bán vọt đã đẩy hệ số biến thiên tăng rồi.
  const buffer = result.variationCoefficient * Math.sqrt(leadTimeDays) * 3;

  return Math.max(3, Math.round(buffer));
}

function assess(
  months: MonthlySales[],
  promotions: PromotionWindow[],
): MonthAssessment[] {
  const rates = months.map(rate);
  // Dùng trung vị làm mốc so sánh: một tháng đột biến không kéo lệch mốc như
  // trung bình cộng.
  const reference = median(rates);

  return months.map((month, index) => {
    const dailyRate = rates[index];
    const ratio = reference > 0 ? dailyRate / reference : 1;
    const anomaly: MonthAnomaly =
      reference <= 0
        ? 'NORMAL'
        : ratio >= SPIKE_THRESHOLD
          ? 'SPIKE'
          : ratio <= DROP_THRESHOLD
            ? 'DROP'
            : 'NORMAL';

    const overlapping = promotions.filter((promotion) =>
      overlapsMonth(month.month, promotion),
    );

    return {
      month: month.month,
      dailyRate: round(dailyRate),
      anomaly,
      ratio: round(ratio),
      hasPromotion: overlapping.length > 0,
      promotionNames: overlapping
        .map((promotion) => promotion.name)
        .filter((name): name is string => Boolean(name)),
      // Bán vọt mà không có khuyến mãi → nhiều khả năng do trend.
      // Bán tụt thì không quy cho trend, vì nguyên nhân thường là hết hàng.
      suspectedTrend: anomaly === 'SPIKE' && overlapping.length === 0,
    };
  });
}

function overlapsMonth(month: string, promotion: PromotionWindow): boolean {
  const start = `${promotion.startDate.toISOString().slice(0, 7)}`;
  const end = `${promotion.endDate.toISOString().slice(0, 7)}`;
  return month >= start && month <= end;
}

function rate(month: MonthlySales): number {
  return month.days > 0 ? month.quantity / month.days : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (average <= 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / average;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
