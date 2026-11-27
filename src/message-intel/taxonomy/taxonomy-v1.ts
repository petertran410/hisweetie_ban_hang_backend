/**
 * Taxonomy v1 cho phân loại từng tin nhắn khách (Message Intelligence) và bộ câu hỏi Jev tương ứng.
 * Câu hỏi viết tiếng Anh (ngôn ngữ chính của Jev), nội dung tin là tiếng Việt — benchmark giai đoạn 2
 * sẽ so với bản câu hỏi tiếng Việt. Bộ câu hỏi được lưu vào smax_intel_versions.questions khi tạo
 * phiên bản; đổi nội dung ở đây không ảnh hưởng phiên bản đã kích hoạt.
 */

/** Ý định chính (1 tin 1 intent). `other` / `unclear` để cuối: Jev hơi thiên về lựa chọn đầu. */
export const INTENTS = {
  order: [
    'Đặt hàng',
    'Places a new order or asks to buy specific products/quantities now.',
  ],
  order_change: [
    'Điều chỉnh đơn',
    'Changes an existing order: add/remove items, quantity, delivery date or address.',
  ],
  order_cancel: ['Hủy đơn', 'Asks to cancel an existing order.'],
  price_inquiry: [
    'Hỏi giá',
    'Asks about prices, quotes, discounts or price lists.',
  ],
  stock_inquiry: [
    'Hỏi tồn kho',
    'Asks whether products are in stock or when they will be available.',
  ],
  product_inquiry: [
    'Hỏi sản phẩm',
    'Asks about product details, specifications, usage, shelf life or differences.',
  ],
  recipe_inquiry: [
    'Hỏi công thức',
    'Asks how to make drinks or recipes with the products.',
  ],
  delivery_inquiry: [
    'Hỏi giao hàng',
    'Asks about delivery status, time, shipping method, carrier or tracking.',
  ],
  payment: [
    'Thanh toán/công nợ',
    'About payment, bank transfer, invoices, debt or payment confirmation.',
  ],
  complaint: [
    'Khiếu nại',
    'Complains about a problem: wrong/missing/damaged items, quality, late delivery, bad service.',
  ],
  feedback: [
    'Góp ý',
    'Gives an opinion or suggestion about products or service without a concrete complaint.',
  ],
  return_refund: [
    'Đổi trả/hoàn tiền',
    'Asks to return or exchange items, or for a refund.',
  ],
  partnership: [
    'Hợp tác/đại lý/OEM',
    'About becoming a distributor/agent, partnership, OEM or wholesale cooperation.',
  ],
  acknowledgment: [
    'Xác nhận',
    'Only confirms or acknowledges (ok, received, agreed) with no new request or problem.',
  ],
  greeting: [
    'Chào hỏi/cảm ơn',
    'Only greets, thanks or says goodbye, with no request.',
  ],
  informational: [
    'Cung cấp thông tin',
    'Provides information (address, receiver, schedule, transfer done) without asking anything.',
  ],
  other: ['Khác', 'A clear message that fits none of the other options.'],
  unclear: [
    'Không đủ thông tin',
    'Too short or ambiguous to tell what the sender wants, even with the conversation context.',
  ],
} as const;
export type Intent = keyof typeof INTENTS;

/** Chủ đề (nhiều chủ đề / tin): mỗi chủ đề là 1 câu noul. */
export const TOPICS = {
  product: ['Sản phẩm', 'products in general'],
  product_quality: ['Chất lượng', 'product quality, taste, defects or expiry'],
  packaging: ['Bao bì', 'packaging, labels or package condition'],
  pricing: ['Giá bán', 'prices, discounts or price changes'],
  inventory: ['Tồn kho', 'stock availability'],
  order: ['Đơn hàng', 'an order'],
  delivery: ['Giao hàng', 'delivery, shipping or transport'],
  missing_items: ['Thiếu hàng', 'items missing from a delivery'],
  wrong_items: ['Giao sai', 'wrong items delivered'],
  payment: ['Thanh toán', 'payment or bank transfer'],
  debt: ['Công nợ', 'outstanding debt or credit balance'],
  recipe: ['Công thức', 'drink recipes or how to use products'],
  customer_service: ['CSKH', 'staff attitude or customer service'],
  competitor: ['Đối thủ', 'a competitor or another supplier'],
  promotion: ['Khuyến mãi', 'promotions, gifts or vouchers'],
  workshop: ['Workshop', 'workshops, training or classes'],
  distribution: [
    'Đại lý/phân phối',
    'distribution, agents or wholesale networks',
  ],
} as const;
export type Topic = keyof typeof TOPICS;

export const SENTIMENTS = {
  positive: ['Tích cực', 'Satisfied, happy, thankful or friendly.'],
  neutral: ['Trung tính', 'Neutral or purely factual.'],
  negative: ['Tiêu cực', 'Unhappy, annoyed, disappointed or angry.'],
} as const;
export type Sentiment = keyof typeof SENTIMENTS;

export const URGENCY_LEVELS = [
  'Not urgent: no action needed or can wait for days',
  'Normal: should be handled in normal working order today or tomorrow',
  'High: should be handled within a few hours',
  'Critical: needs immediate action now (e.g. delivery happening now, serious problem, angry customer)',
] as const;

export const PURCHASE_INTENT_LEVELS = [
  'None: no sign of wanting to buy',
  'Low: some interest, just exploring',
  'Medium: considering a purchase, comparing or asking details',
  'High: clearly wants to buy or is ordering now',
] as const;

export const FLAGS = {
  requires_reply: [
    'Does the sender expect a reply or action from the seller to this message?',
    'Yes if it asks a question, makes a request or reports a problem. No for pure acknowledgments, thanks or information that needs no answer.',
  ],
  requires_escalation: [
    'Does this message need a manager or senior staff to step in?',
    'Yes for serious complaints, threats to stop buying, refund disputes, large losses or repeated unresolved problems.',
  ],
  is_anomaly: [
    'Does this message reveal an unusual business problem?',
    'Yes for problems such as missing/wrong/damaged goods, quality defects, price or invoice errors, failed deliveries or payment mismatches.',
  ],
} as const;
export type Flag = keyof typeof FLAGS;

/** Ngưỡng noul (điểm khởi đầu theo tài liệu Jev; hiệu chỉnh sau benchmark). */
export type IntelThresholds = { yes: number; no: number; topic: number };
export const DEFAULT_THRESHOLDS: IntelThresholds = {
  yes: 0.7,
  no: 0.3,
  topic: 0.5,
};

export const JEV_MODEL = 'jev-1.14.0';

/** Ngữ cảnh doanh nghiệp đưa vào state (Jev không có system prompt). */
export const BUSINESS_CONTEXT =
  'Vietnamese B2B chat between a beverage-ingredient supplier (Diệp Trà / LerMao: tea, syrups, toppings for cafés and milk-tea shops) and its customers. Messages are in Vietnamese and may use slang or abbreviations.';

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true: string; false: string };
    };

const TARGET =
  'the target message (`target`), using `quoted` and `previous` only as context';
export const TOPIC_PREFIX = 'topic_';

/** Bộ câu hỏi Jev của taxonomy v1 (tất cả trong 1 request / tin). */
export function buildJevQuestions(): Record<string, JevQuestion> {
  const fromMap = (m: Record<string, readonly [string, string]>) =>
    Object.fromEntries(Object.entries(m).map(([k, [, desc]]) => [k, desc]));
  const questions: Record<string, JevQuestion> = {
    intent: {
      type: 'choice',
      instructions: `What is the main intent of ${TARGET}?`,
      criteria: fromMap(INTENTS),
    },
    sentiment: {
      type: 'choice',
      instructions: `What is the sentiment of ${TARGET}?`,
      criteria: fromMap(SENTIMENTS),
    },
    urgency: {
      type: 'score',
      instructions: `How urgent is ${TARGET} for the seller?`,
      criteria: [...URGENCY_LEVELS],
    },
    purchase_intent: {
      type: 'score',
      instructions: `How strong is the purchase intent in ${TARGET}?`,
      criteria: [...PURCHASE_INTENT_LEVELS],
    },
  };
  for (const [key, [, about]] of Object.entries(TOPICS))
    questions[`${TOPIC_PREFIX}${key}`] = {
      type: 'noul',
      instructions: `Is ${TARGET} about ${about}?`,
    };
  for (const [key, [question, yes]] of Object.entries(FLAGS))
    questions[key] = {
      type: 'noul',
      instructions: `${question} Judge ${TARGET}.`,
      criteria: { true: yes, false: 'Otherwise.' },
    };
  return questions;
}
