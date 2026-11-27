import { ConflictException } from '@nestjs/common';
import { LarkCustomerSyncService } from './lark-customer-sync.service';

describe('LarkCustomerSyncService — bulk lock', () => {
  const build = (opts: { fetchAll?: jest.Mock } = {}) => {
    // findMany treo tới khi test gọi release() → giữ phiên bulk ở trạng thái chạy
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const customers = [
      { id: 1, code: 'KH001', isActive: true, larkRecordId: null, addresses: [] },
    ];

    const prisma = {
      customer: {
        findMany: jest.fn().mockImplementation(async () => {
          await gate;
          return customers;
        }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const larkBase = {
      isEnabled: () => true,
      verifyRecordIds: jest.fn().mockResolvedValue(new Set()),
      fetchAllRecords: opts.fetchAll ?? jest.fn().mockResolvedValue(new Map()),
      batchCreateRecords: jest.fn().mockResolvedValue(['rec1']),
      batchUpdateRecords: jest.fn(),
    };
    const config = { get: () => 'tbl-customer' };

    const service = new LarkCustomerSyncService(
      larkBase as any,
      prisma as any,
      config as any,
    );
    return { service, prisma, larkBase, release: () => release() };
  };

  it('chạy nền lần 2 khi lần 1 chưa xong → không tạo phiên mới', async () => {
    const { service, larkBase, release } = build();

    const first = service.startBulkSyncInBackground();
    const second = service.startBulkSyncInBackground();

    expect(first.started).toBe(true);
    expect(first.status.running).toBe(true);
    expect(second.started).toBe(false);
    await expect(service.syncPendingAndFailed()).rejects.toBeInstanceOf(
      ConflictException,
    );

    release();
    await new Promise((r) => setImmediate(r));

    expect(larkBase.batchCreateRecords).toHaveBeenCalledTimes(1);
    const status = service.getBulkSyncStatus();
    expect(status.running).toBe(false);
    expect(status.success).toBe(1);
    expect(status.failed).toBe(0);
  });

  it('sync lẻ trong lúc bulk chạy → hoãn, không đụng DB/Lark', async () => {
    const { service, prisma, release } = build();
    const enqueue = jest.spyOn(service, 'enqueueSync').mockImplementation();

    service.startBulkSyncInBackground();
    await service.syncSingle(1);

    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setImmediate(r));

    // Bulk xong → KH bị hoãn được xếp lại hàng đợi
    expect(enqueue).toHaveBeenCalledWith(1);
  });

  it('không lấy được danh sách record Lark → không batchCreate (tránh trùng)', async () => {
    const fetchAll = jest.fn().mockRejectedValue(new Error('rate limited'));
    const { service, larkBase, release } = build({ fetchAll });

    const run = service.syncPendingAndFailed();
    release();
    const result = await run;

    expect(larkBase.batchCreateRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ success: 0, failed: 1 });
  });
});
