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

describe('MisaDictionaryService inventory item unit names', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'MISA_BASE_URL'
        ? 'https://developer.misa.vn/apis'
        : key === 'MISA_CLIENT_ID'
          ? 'client-id'
          : undefined,
    ),
  };

  /**
   * Mock get_dictionary theo data_type: 2 = vật tư, 4 = đơn vị tính.
   * `units` = Error → data_type 4 trả Success=false.
   */
  const buildService = (items: unknown[], units: unknown[] | Error) => {
    const post = jest.fn((_url: string, body: { data_type: number }) => {
      if (body.data_type === 4) {
        return of({
          data:
            units instanceof Error
              ? { Success: false, ErrorMessage: units.message }
              : { Success: true, Data: units },
        });
      }
      return of({ data: { Success: true, Data: items } });
    });
    const upsert = jest.fn().mockResolvedValue({});
    const service = new MisaDictionaryService(
      config as any,
      { post } as any,
      { misaInventoryItem: { upsert } } as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
    );
    return { service, post, upsert };
  };

  const baseItem = {
    dictionary_type: 2,
    inventory_item_id: 'item-1',
    inventory_item_code: 'VT01',
    inventory_item_name: 'Vật tư 1',
    inventory_item_type: 0,
  };

  it('resolves unit name from the unit dictionary when unit_name is missing', async () => {
    const { service, post, upsert } = buildService(
      [{ ...baseItem, unit_id: 'UNIT-1' }],
      [{ unit_id: 'unit-1', unit_name: ' Hộp ' }],
    );

    await expect(service.syncInventoryItems()).resolves.toBe(1);

    expect(post.mock.calls.map((call) => call[1].data_type)).toEqual([4, 2]);
    const args = upsert.mock.calls[0][0];
    expect(args.update).toMatchObject({ unitId: 'UNIT-1', unitName: 'Hộp' });
    expect(args.create).toMatchObject({ unitId: 'UNIT-1', unitName: 'Hộp' });
  });

  it('prefers unit_name returned on the inventory item', async () => {
    const { service, upsert } = buildService(
      [{ ...baseItem, unit_id: 'unit-1', unit_name: 'Cái' }],
      [{ unit_id: 'unit-1', unit_name: 'Hộp' }],
    );

    await service.syncInventoryItems();

    expect(upsert.mock.calls[0][0].update.unitName).toBe('Cái');
  });

  it('does not overwrite stored unit fields when no unit can be resolved', async () => {
    const { service, upsert } = buildService([{ ...baseItem }], []);

    await expect(service.syncInventoryItems()).resolves.toBe(1);

    const args = upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty('unitName');
    expect(args.update).not.toHaveProperty('unitId');
    expect(args.create.unitName).toBeNull();
    expect(args.create.unitId).toBeNull();
  });

  it('still syncs inventory items when the unit dictionary fails', async () => {
    const { service, upsert } = buildService(
      [{ ...baseItem, unit_id: 'unit-1' }],
      new Error('Unit API down'),
    );

    await expect(service.syncInventoryItems()).resolves.toBe(1);

    const args = upsert.mock.calls[0][0];
    expect(args.update).toMatchObject({ unitId: 'unit-1' });
    expect(args.update).not.toHaveProperty('unitName');
  });
});
