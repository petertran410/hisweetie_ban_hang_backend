import { of } from 'rxjs';
import { MisaDictionaryService } from './misa-dictionary.service';

describe('MisaDictionaryService OpenAPI dictionary flow', () => {
  it('syncs stock data returned as an array and preserves isDefault', async () => {
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          Success: true,
          Data: [
            {
              dictionary_type: 3,
              stock_id: 'stock-1',
              stock_code: 'KHO1',
              stock_name: 'Kho 1',
              branch_id: 'misa-branch-1',
              inactive: false,
              inventory_account: '1561',
            },
          ],
        },
      }),
    );
    const upsert = jest.fn().mockResolvedValue({});
    const config = {
      get: jest.fn((key: string) =>
        key === 'MISA_BASE_URL'
          ? 'https://developer.misa.vn/apis'
          : key === 'MISA_CLIENT_ID'
            ? 'client-id'
            : undefined,
      ),
    };
    const prisma = {
      misaStock: { upsert },
    };
    const auth = {
      getAccessToken: jest.fn().mockResolvedValue('access-token'),
    };

    const service = new MisaDictionaryService(
      config as any,
      { post } as any,
      prisma as any,
      auth as any,
    );

    await expect(service.syncStocks()).resolves.toBe(1);

    expect(post).toHaveBeenCalledWith(
      'https://developer.misa.vn/apis/amiskt/v1/get_dictionary',
      {
        data_type: 3,
        skip: 0,
        take: 1000,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ClientID: 'client-id',
          'X-MISA-AccessToken': 'access-token',
        },
      },
    );
    expect(upsert).toHaveBeenCalledWith({
      where: { stockId: 'stock-1' },
      update: {
        stockCode: 'KHO1',
        stockName: 'Kho 1',
        branchId: 'misa-branch-1',
        inactive: false,
        inventoryAccount: '1561',
      },
      create: {
        stockId: 'stock-1',
        stockCode: 'KHO1',
        stockName: 'Kho 1',
        branchId: 'misa-branch-1',
        inactive: false,
        inventoryAccount: '1561',
      },
    });
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('isDefault');
    expect(upsert.mock.calls[0][0].create).not.toHaveProperty('isDefault');
  });

  it.each([
    [
      'JSON string',
      JSON.stringify([
        {
          dictionary_type: 3,
          stock_id: 'stock-string',
          stock_code: 'KHO-STRING',
          stock_name: 'Kho string',
        },
      ]),
    ],
    [
      'wrapper object',
      {
        items: [
          {
            dictionary_type: 3,
            stock_id: 'stock-wrapper',
            stock_code: 'KHO-WRAPPER',
            stock_name: 'Kho wrapper',
          },
        ],
      },
    ],
  ])('normalizes dictionary Data from %s', async (_label, data) => {
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          Success: true,
          Data: data as any,
        },
      }),
    );
    const upsert = jest.fn().mockResolvedValue({});
    const config = {
      get: jest.fn((key: string) =>
        key === 'MISA_BASE_URL'
          ? 'https://developer.misa.vn/apis'
          : key === 'MISA_CLIENT_ID'
            ? 'client-id'
            : undefined,
      ),
    };
    const service = new MisaDictionaryService(
      config as any,
      { post } as any,
      { misaStock: { upsert } } as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
    );

    await expect(service.syncStocks()).resolves.toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
