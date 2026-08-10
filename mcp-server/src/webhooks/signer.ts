import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhook(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
