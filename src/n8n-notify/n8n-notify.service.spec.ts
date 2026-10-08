import axios from 'axios';
import { N8nNotifyService } from './n8n-notify.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

const mockedAxiosPost = axios.post as jest.Mock;

describe('N8nNotifyService cold cargo payload', () => {
  const packingSlip = {
    id: 10,
    code: 'BD000010',
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    branchId: 1,
    branch: { id: 1, name: 'Chi nhánh chính' },
    creator: { id: 7, name: 'Nhân viên giao hàng' },
    numberOfPackages: 2,
    paymentMethod: 'transfer',
    hasColdItems: true,
    coldItemCount: 2,
    invoices: [
      {
        invoiceId: 101,
        invoice: {
          id: 101,
          code: 'HD000101',
          grandTotal: 100000,
          customer: {
            id: 501,
            code: 'KH001',
            name: 'Khách hàng',
            contactNumber: '0900000000',
          },
          soldBy: { name: 'Người bán' },
        },
      },
    ],
    images: [],
  };

  beforeEach(() => {
    mockedAxiosPost.mockReset();
    mockedAxiosPost.mockResolvedValue({ status: 200 });
  });

  it('sends a cold warning flag through the normal delivery webhook', async () => {
    const service = new N8nNotifyService({
      get: jest.fn((key: string) =>
        key === 'N8N_DELIVERY_WEBHOOK_URL'
          ? 'https://n8n.example/webhook/delivery'
          : key === 'N8N_WEBHOOK_SECRET'
            ? 'secret'
            : key === 'APP_PUBLIC_URL'
              ? 'https://pos.example'
              : undefined,
      ),
    } as any);

    await service.notifyDelivery(packingSlip as any);

    const payload = mockedAxiosPost.mock.calls[0][1];
    expect(payload.packingSlip.coldCargoWarning).toEqual({
      hasColdItems: true,
      coldItemCount: 2,
    });
  });

  it('sends the same cold warning flag through the Bibi webhook', async () => {
    const service = new N8nNotifyService({
      get: jest.fn((key: string) =>
        key === 'N8N_BIBI_WEBHOOK_URL'
          ? 'https://n8n.example/webhook/bibi'
          : key === 'N8N_BIBI_CUSTOMER_CODE'
            ? 'KH001'
            : key === 'N8N_WEBHOOK_SECRET'
              ? 'secret'
              : key === 'APP_PUBLIC_URL'
                ? 'https://pos.example'
                : undefined,
      ),
    } as any);

    await service.notifyBibiDelivery(packingSlip as any);

    const payload = mockedAxiosPost.mock.calls[0][1];
    expect(payload.packingSlip.coldCargoWarning).toEqual({
      hasColdItems: true,
      coldItemCount: 2,
    });
  });

  it('does not mark a normal delivery as cold', async () => {
    const service = new N8nNotifyService({
      get: jest.fn((key: string) =>
        key === 'N8N_DELIVERY_WEBHOOK_URL'
          ? 'https://n8n.example/webhook/delivery'
          : undefined,
      ),
    } as any);

    await service.notifyDelivery({
      ...packingSlip,
      hasColdItems: false,
      coldItemCount: 0,
    } as any);

    const payload = mockedAxiosPost.mock.calls[0][1];
    expect(payload.packingSlip.coldCargoWarning).toEqual({
      hasColdItems: false,
      coldItemCount: 0,
    });
  });
});
