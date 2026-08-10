import { createHmac, timingSafeEqual } from 'node:crypto';
export function signWebhook(secret, timestamp, body) {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export function verifyWebhook(secret, timestamp, body, signature) {
    const expected = Buffer.from(signWebhook(secret, timestamp, body));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
}
//# sourceMappingURL=signer.js.map