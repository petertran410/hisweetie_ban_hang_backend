import { TransfersService } from './transfers.service';

describe('TransfersService quick create', () => {
  const user = { id: 9, name: 'Tester' };
  const branches = [
    { id: 6, name: 'Kho Hà Nội' },
    { id: 1, name: 'Kho Sài Gòn' },
  ];
  const updatedAt = new Date('2026-09-07T00:00:00Z');
  const drafts = [
    { id: 11, userId: 9, productId: 101, quantity: 3, updatedAt },
    { id: 12, userId: 9, productId: 102, quantity: 5, updatedAt },
  ];
  const products = [
    { id: 101, code: 'SP101', name: 'Sản phẩm 101' },
    { id: 102, code: 'SP102', name: 'Sản phẩm 102' },
  ];

  const makeService = (existingTransfer?: any) => {
    const transferDetailUpsert = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: drafts.length });
    const createdTransfer = {
      id: 88,
      code: 'TRF000088',
      fromBranchId: 6,
      toBranchId: 1,
      fromBranchName: 'Kho Hà Nội',
      toBranchName: 'Kho Sài Gòn',
      details: [],
    };
    const tx = {
      transferTempQuantity: {
        findMany: jest.fn().mockResolvedValue(drafts),
        deleteMany,
      },
      product: { findMany: jest.fn().mockResolvedValue(products) },
      inventory: {
        findMany: jest.fn().mockResolvedValue([
          { productId: 101, cost: 10 },
          { productId: 102, cost: 20 },
        ]),
      },
      branch: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(branches.find((b) => b.id === where.id)),
        ),
      },
      transfer: {
        findFirst: jest.fn().mockResolvedValue({ code: 'TRF000087' }),
        findUnique: jest.fn(({ where, include }) => {
          if (include) return Promise.resolve(existingTransfer || null);
          return Promise.resolve(null);
        }),
        create: jest.fn().mockResolvedValue(createdTransfer),
        update: jest.fn().mockResolvedValue({
          ...(existingTransfer || createdTransfer),
          fromBranchName: 'Kho Hà Nội',
          toBranchName: 'Kho Sài Gòn',
        }),
      },
      transferDetail: {
        upsert: transferDetailUpsert,
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { totalTransfer: 130 } }),
      },
    };
    const prisma = {
      branch: { findMany: jest.fn().mockResolvedValue(branches) },
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const auditLogs = { create: jest.fn().mockResolvedValue({}) };
    const service = new TransfersService(
      prisma as any,
      auditLogs as any,
      {} as any,
    );
    return { service, tx, deleteMany, transferDetailUpsert };
  };

  it('tạo phiếu mới bằng tempQty và reset đúng draft trong transaction', async () => {
    const { service, tx, deleteMany } = makeService();

    const result = await service.quickCreateTransfer(
      { productIds: [101, 102] },
      user.id,
    );

    expect(result).toEqual({
      transfer: { id: 88, code: 'TRF000088' },
      createdNew: true,
      itemCount: 2,
    });
    expect(tx.transferTempQuantity.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: user.id,
        fromBranchId: 6,
        toBranchId: 1,
      }),
    });
    expect(tx.transfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 1,
          details: {
            create: expect.arrayContaining([
              expect.objectContaining({ productId: 101, sendQuantity: 3 }),
              expect.objectContaining({ productId: 102, sendQuantity: 5 }),
            ]),
          },
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { id: 11, quantity: 3, updatedAt },
          { id: 12, quantity: 5, updatedAt },
        ],
      },
    });
  });

  it('cộng dồn SKU trùng và thêm SKU mới vào phiếu tạm existing', async () => {
    const existing = {
      id: 77,
      code: 'TRF000077',
      status: 1,
      isActive: true,
      fromBranchId: 6,
      toBranchId: 1,
      fromBranchName: 'Kho Hà Nội',
      toBranchName: 'Kho Sài Gòn',
      details: [{ productId: 101, sendPrice: 15 }],
    };
    const { service, transferDetailUpsert } = makeService(existing);

    await service.quickCreateTransfer(
      { transferId: 77, productIds: [101, 102] },
      user.id,
    );

    expect(transferDetailUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transferId_productId: { transferId: 77, productId: 101 } },
        update: {
          sendQuantity: { increment: 3 },
          totalTransfer: { increment: 45 },
        },
      }),
    );
    expect(transferDetailUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ productId: 102, sendQuantity: 5 }),
      }),
    );
  });

  it('không reset draft nếu phiếu existing không còn ở trạng thái tạm', async () => {
    const existing = {
      id: 77,
      code: 'TRF000077',
      status: 2,
      isActive: true,
      fromBranchId: 6,
      toBranchId: 1,
      details: [],
    };
    const { service, deleteMany } = makeService(existing);

    await expect(
      service.quickCreateTransfer(
        { transferId: 77, productIds: [101] },
        user.id,
      ),
    ).rejects.toThrow('Chỉ có thể thêm vào phiếu tạm');

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('không reset draft nếu tạo phiếu mới thất bại', async () => {
    const { service, tx, deleteMany } = makeService();
    tx.transfer.create.mockRejectedValueOnce(new Error('create failed'));

    await expect(
      service.quickCreateTransfer({ productIds: [101, 102] }, user.id),
    ).rejects.toThrow('create failed');

    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('TransfersService reset temp quantities', () => {
  it('chỉ reset draft của user hiện tại trên tuyến HN → SG', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
    const prisma = {
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: 6, name: 'Kho Hà Nội' },
          { id: 1, name: 'Kho Sài Gòn' },
        ]),
      },
      transferTempQuantity: { deleteMany },
    };
    const service = new TransfersService(prisma as any, {} as any, {} as any);

    await expect(service.resetTempQuantities(9)).resolves.toEqual({
      resetCount: 4,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 9, fromBranchId: 6, toBranchId: 1 },
    });
  });
});
