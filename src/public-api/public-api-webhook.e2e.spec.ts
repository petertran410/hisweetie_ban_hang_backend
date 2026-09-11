import { createHmac, timingSafeEqual } from 'crypto';
import { PublicApiWebhookService } from './public-api-webhook.service';

describe('PublicApiWebhook E2E delivery simulation', () => {
  const serverUrl = 'https://partner.example.com/webhook-receiver';
  const secret = 'webhook-e2e-secret-key-16chars';
  const receivedRequests: Array<{
    headers: Record<string, string>;
    body: any;
    rawBody: string;
  }> = [];

  beforeAll(() => {
    process.env.ALLOW_INSECURE_WEBHOOK_URLS = 'true';
  });

  afterAll(() => {
    delete process.env.ALLOW_INSECURE_WEBHOOK_URLS;
  });

  beforeEach(() => {
    receivedRequests.length = 0;
  });

  it('bắn webhook qua mạng, ký HMAC hợp lệ và không bỏ sót bản ghi khi có hơn 100 thay đổi', async () => {
    const totalItems = 250;
    const items = Array.from({ length: totalItems }, (_, i) => ({
      id: i + 1,
      name: `Khách hàng ${i + 1}`,
      updatedAt: new Date(Date.now() - (totalItems - i) * 1000),
    }));

    let currentCursorAt: Date | null = null;
    let currentCursorId: number | null = null;

    const prisma: any = {
      publicApiWebhook: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'wh-e2e',
            clientId: 'client-1',
            resource: 'customers',
            url: serverUrl,
            secret,
            cursorAt: currentCursorAt,
            cursorId: currentCursorId,
            isActive: true,
            failureCount: 0,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => {
          if (data.cursorAt) currentCursorAt = data.cursorAt;
          if (data.cursorId !== undefined) currentCursorId = data.cursorId;
          return Promise.resolve({});
        }),
      },
      publicApiWebhookDelivery: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const publicApiService: any = {
      assertResource: (r: string) => r,
      listKeyset: jest.fn().mockImplementation((_resource, options) => {
        const take = options.take || 100;
        const cursorAt = options.cursorAt;
        const cursorId = options.cursorId;

        const filtered = items.filter((item) => {
          if (!cursorAt) return true;
          if (item.updatedAt > cursorAt) return true;
          if (
            item.updatedAt.getTime() === cursorAt.getTime() &&
            item.id > (cursorId || 0)
          ) {
            return true;
          }
          return false;
        });

        const batch = filtered.slice(0, take);
        const last = batch.length > 0 ? batch[batch.length - 1] : null;
        return Promise.resolve({
          data: batch,
          lastCursorAt: last ? last.updatedAt : null,
          lastCursorId: last ? last.id : null,
          hasMore: filtered.length > take,
        });
      }),
    };

    // Mock fetch để gọi server test
    const originalFetch = (global as any).fetch;
    (global as any).fetch = async (url: string, init: any) => {
      receivedRequests.push({
        headers: init.headers,
        body: JSON.parse(init.body),
        rawBody: init.body,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };

    try {
      const service = new PublicApiWebhookService(prisma, publicApiService);
      await service.dispatchPending();

      // 250 items chia làm 3 batch (100 + 100 + 50)
      expect(receivedRequests.length).toBe(3);
      expect(receivedRequests[0].body.data.length).toBe(100);
      expect(receivedRequests[1].body.data.length).toBe(100);
      expect(receivedRequests[2].body.data.length).toBe(50);

      // Kiểm tra tính liên tục: không mất bản ghi nào
      const allIds = receivedRequests.flatMap((r) =>
        r.body.data.map((d: any) => d.id),
      );
      expect(allIds).toHaveLength(totalItems);
      expect(allIds[0]).toBe(1);
      expect(allIds[allIds.length - 1]).toBe(totalItems);

      // Kiểm tra chữ ký HMAC trên từng request
      for (const req of receivedRequests) {
        const signatureHeader = (req.headers['X-Webhook-Signature'] ||
          req.headers['x-webhook-signature']) as string;
        const timestampHeader = (req.headers['X-Webhook-Timestamp'] ||
          req.headers['x-webhook-timestamp']) as string;
        expect(signatureHeader).toBeTruthy();
        expect(timestampHeader).toBeTruthy();

        const expectedSig = createHmac('sha256', secret)
          .update(`${timestampHeader}.${req.rawBody}`)
          .digest('hex');

        const valid = timingSafeEqual(
          Buffer.from(signatureHeader),
          Buffer.from(expectedSig),
        );
        expect(valid).toBe(true);
      }
    } finally {
      (global as any).fetch = originalFetch;
    }
  });
});
