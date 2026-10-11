import { TransfersController } from './transfers.controller';
import { InternalUseController } from '../internal-use/internal-use.controller';

const transfer = {
  id: 1,
  code: 'TRF1',
  totalTransfer: 100000,
  totalReceive: 0,
  details: [
    {
      productId: 115,
      sendQuantity: 2,
      sendPrice: 50000,
      receivePrice: 50000,
      totalTransfer: 100000,
      totalReceive: 0,
    },
  ],
};

const reqWith = (permissions: string[]) => ({
  user: { id: 9, roles: [] },
  effectivePermissions: permissions,
});

describe('Ẩn giá theo quyền', () => {
  it('Chuyển kho: thiếu transfers:view_cost_price → ẩn đơn giá & giá trị', async () => {
    const service = {
      findOne: jest.fn().mockResolvedValue(transfer),
      findAll: jest.fn().mockResolvedValue({ total: 1, data: [transfer] }),
    };
    const controller = new TransfersController(service as any);

    const one: any = await controller.findOne('1', reqWith(['transfers:view']));
    expect(one.totalTransfer).toBeUndefined();
    expect(one.details[0]).toMatchObject({ productId: 115, sendQuantity: 2 });
    expect(one.details[0].sendPrice).toBeUndefined();
    expect(one.details[0].totalTransfer).toBeUndefined();

    const list: any = await controller.findAll({} as any, reqWith([]));
    expect(list.total).toBe(1);
    expect(list.data[0].totalTransfer).toBeUndefined();
    expect(list.data[0].details[0].sendPrice).toBeUndefined();
  });

  it('Chuyển kho: có quyền → giữ nguyên giá', async () => {
    const service = { findOne: jest.fn().mockResolvedValue(transfer) };
    const controller = new TransfersController(service as any);

    const one: any = await controller.findOne(
      '1',
      reqWith(['transfers:view', 'transfers:view_cost_price']),
    );
    expect(one).toBe(transfer);
  });

  it('Xuất dùng: cần cả internal-use & products view_cost_price', async () => {
    const internalUse = {
      id: 1,
      totalValue: 90000,
      details: [{ productId: 1, quantity: 3, cost: 30000, value: 90000 }],
    };
    const service = { findOne: jest.fn().mockResolvedValue(internalUse) };
    const controller = new InternalUseController(service as any);

    const hidden: any = await controller.findOne(
      '1',
      reqWith(['internal-use:view_cost_price']),
    );
    expect(hidden.totalValue).toBeUndefined();
    expect(hidden.details[0]).toMatchObject({ productId: 1, quantity: 3 });
    expect(hidden.details[0].cost).toBeUndefined();

    const shown: any = await controller.findOne(
      '1',
      reqWith(['internal-use:view_cost_price', 'products:view_cost_price']),
    );
    expect(shown).toBe(internalUse);
  });
});
