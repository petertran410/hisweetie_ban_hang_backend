import { createHash } from 'crypto';

export const TIKTOK_OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  SENT: 'SENT',
  DEAD: 'DEAD',
  SKIPPED: 'SKIPPED',
} as const;

export const TIKTOK_ERROR_CLASSIFICATION = {
  RETRYABLE: 'RETRYABLE',
  PERMANENT: 'PERMANENT',
} as const;

export interface TiktokCustomerPii {
  id: number;
  phone?: string | null;
  contactNumber?: string | null;
}

export interface TiktokInvoiceItem {
  productCode?: string | null;
  quantity: number;
  price: number;
  totalPrice: number;
}

export interface TiktokInvoiceData {
  id: number;
  code: string;
  createdAt: Date;
  grandTotal: number;
  customer: TiktokCustomerPii | null;
  details: TiktokInvoiceItem[];
}

export interface TiktokRegistrationData {
  id: number;
  phone?: string | null;
  contactNumber?: string | null;
  createdAt: Date;
}

export interface TiktokEventPayload {
  event_source: string;
  event_source_id: string;
  test_event_code?: string;
  data: Array<{
    event: string;
    event_time: number;
    event_id: string;
    user: {
      phone?: string;
    };
    properties?: Record<string, any>;
  }>;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
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

function extractPhone(customer: TiktokCustomerPii | null): string | null {
  if (!customer) return null;
  const phone = customer.contactNumber?.trim() || customer.phone?.trim();
  if (!phone) return null;
  const normalized = normalizePhoneVietnam(phone);
  if (!isValidPhone(normalized)) return null;
  return sha256(normalized);
}

export function buildPurchasePayload(
  invoice: TiktokInvoiceData,
  pixelId: string,
  testEventCode?: string,
): TiktokEventPayload {
  const hashedPhone = extractPhone(invoice.customer);
  const eventId = `prod:tt:invoice:${invoice.id}`;
  const eventTime = Math.floor(invoice.createdAt.getTime() / 1000);
  const value = Math.round(Number(invoice.grandTotal));

  const contents = invoice.details
    .filter((d) => d.productCode)
    .map((d) => ({
      content_id: d.productCode!,
      quantity: Number(d.quantity),
      price: Number(d.totalPrice) / Number(d.quantity),
    }));

  const numItems = invoice.details.reduce(
    (sum, d) => sum + Number(d.quantity),
    0,
  );

  const user: { phone?: string } = {};
  if (hashedPhone) user.phone = hashedPhone;

  const result: TiktokEventPayload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [
      {
        event: 'Purchase',
        event_time: eventTime,
        event_id: eventId,
        user,
        properties: {
          currency: 'VND',
          value,
          contents,
          num_items: numItems,
        },
      },
    ],
  };

  if (testEventCode) result.test_event_code = testEventCode;
  return result;
}

export function buildRegistrationPayload(
  customer: TiktokRegistrationData,
  pixelId: string,
  testEventCode?: string,
): TiktokEventPayload {
  const phone = customer.contactNumber?.trim() || customer.phone?.trim();
  let hashedPhone: string | undefined;
  if (phone) {
    const normalized = normalizePhoneVietnam(phone);
    if (isValidPhone(normalized)) {
      hashedPhone = sha256(normalized);
    }
  }

  const eventId = `prod:tt:customer:${customer.id}`;
  const eventTime = Math.floor(customer.createdAt.getTime() / 1000);

  const user: { phone?: string } = {};
  if (hashedPhone) user.phone = hashedPhone;

  const result: TiktokEventPayload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [
      {
        event: 'CompleteRegistration',
        event_time: eventTime,
        event_id: eventId,
        user,
      },
    ],
  };

  if (testEventCode) result.test_event_code = testEventCode;
  return result;
}

export function hasUserData(payload: TiktokEventPayload): boolean {
  const user = payload.data[0]?.user;
  return !!(user && user.phone);
}
