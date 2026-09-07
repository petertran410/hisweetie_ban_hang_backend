import { createHash } from 'crypto';

export const META_OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  SENT: 'SENT',
  DEAD: 'DEAD',
  SKIPPED: 'SKIPPED',
} as const;

export const META_ERROR_CLASSIFICATION = {
  RETRYABLE: 'RETRYABLE',
  PERMANENT: 'PERMANENT',
} as const;

export interface CustomerPii {
  id: number;
  email?: string | null;
  phone?: string | null;
  contactNumber?: string | null;
}

export interface InvoiceItem {
  productId?: number | null;
  productCode?: string | null;
  productName?: string | null;
  quantity: number;
  price: number;
  totalPrice: number;
  isGift?: boolean;
  lineType?: string | null;
}

export interface InvoiceForPurchase {
  id: number;
  code: string;
  createdAt: Date;
  grandTotal: number;
  customer: CustomerPii | null;
  details: InvoiceItem[];
}

export interface MetaPurchasePayload {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  user_data: {
    em?: string[];
    ph?: string[];
    external_id?: string[];
  };
  custom_data: {
    currency: string;
    value: number;
    order_id: string;
    content_type: string;
    content_ids: string[];
    contents: Array<{
      id: string;
      quantity: number;
      item_price: number;
    }>;
    num_items: number;
  };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhoneVietnam(phone: string): string {
  let cleaned = phone.replace(/[\s.\-+()]/g, '');
  cleaned = cleaned.replace(/^0/, '84');
  cleaned = cleaned.replace(/^\+84/, '84');
  return cleaned;
}

function isValidPhone(phone: string): boolean {
  return /^84\d{7,11}$/.test(phone);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function buildUserData(
  customer: CustomerPii | null,
  namespace: string,
): MetaPurchasePayload['user_data'] {
  const userData: MetaPurchasePayload['user_data'] = {};

  if (customer) {
    const email = customer.email?.trim();
    if (email && isValidEmail(email)) {
      userData.em = [sha256(normalizeEmail(email))];
    }

    const phone = customer.contactNumber?.trim() || customer.phone?.trim();
    if (phone) {
      const normalized = normalizePhoneVietnam(phone);
      if (isValidPhone(normalized)) {
        userData.ph = [sha256(normalized)];
      }
    }

    if (namespace && customer.id) {
      userData.external_id = [
        sha256(`${namespace}:customer:${customer.id}`),
      ];
    }
  }

  return userData;
}

export function hasAnyUserData(
  userData: MetaPurchasePayload['user_data'],
): boolean {
  return !!(
    (userData.em && userData.em.length > 0) ||
    (userData.ph && userData.ph.length > 0) ||
    (userData.external_id && userData.external_id.length > 0)
  );
}

export function buildPayload(
  invoice: InvoiceForPurchase,
  config: {
    namespace: string;
    actionSource: string;
    datasetId: string;
  },
): MetaPurchasePayload {
  const userData = buildUserData(invoice.customer, config.namespace);

  const nonGiftDetails = invoice.details.filter(
    (d) => !d.isGift && d.lineType !== 'gift',
  );

  const contentIds = nonGiftDetails
    .map((d) => d.productCode)
    .filter((c): c is string => !!c);

  const contents = nonGiftDetails
    .filter((d) => d.productCode)
    .map((d) => ({
      id: d.productCode!,
      quantity: Number(d.quantity),
      item_price: Number(d.totalPrice) / Number(d.quantity),
    }));

  const numItems = nonGiftDetails.reduce(
    (sum, d) => sum + Number(d.quantity),
    0,
  );

  const eventId = `${config.namespace}:invoice:${invoice.id}`;

  const eventTime = Math.floor(invoice.createdAt.getTime() / 1000);

  const value = Math.round(Number(invoice.grandTotal));

  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: eventId,
    action_source: config.actionSource,
    user_data: userData,
    custom_data: {
      currency: 'VND',
      value,
      order_id: invoice.code,
      content_type: 'product',
      content_ids: contentIds,
      contents,
      num_items: numItems,
    },
  };
}