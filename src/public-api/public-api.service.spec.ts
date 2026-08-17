import { NotFoundException } from '@nestjs/common';
import { PublicApiService } from './public-api.service';

describe('PublicApiService', () => {
  const createService = () => {
    const delegate = () => ({ findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() });
    const prisma: any = {
      branch: delegate(), customerType: delegate(), customerGroup: delegate(), customer: delegate(),
      product: delegate(), inventory: delegate(), order: delegate(), invoice: delegate(), returnOrder: delegate(),
      category: delegate(), tradeMark: delegate(), saleChannel: delegate(), bankAccount: delegate(),
      user: delegate(), supplier: delegate(), supplierGroup: delegate(), priceBook: delegate(),
      purchaseOrder: delegate(), transfer: delegate(), cashFlow: delegate(),
      surcharge: delegate(), location: delegate(), settings: delegate(),
      orderSupplier: delegate(), consignment: delegate(), supplierReturn: delegate(),
    };
    // list() gói count + findMany vào $transaction để tổng và trang đọc cùng
    // một ảnh chụp dữ liệu; mock giữ nguyên thứ tự [count, findMany].
    prisma.$transaction = jest.fn((operations: Promise<unknown>[]) => Promise.all(operations));
    return { prisma, service: new PublicApiService(prisma as any) };
  };

  const timestamp = new Date('2026-08-14T10:00:00.000Z');

  it('trả envelope KiotViet với total/pageSize/currentItem/data/timestamp', async () => {
    const { service, prisma } = createService();
    prisma.branch.count.mockResolvedValue(7);
    prisma.branch.findMany.mockResolvedValue([
      { id: 10, name: 'A', isActive: true, updatedAt: timestamp },
      { id: 11, name: 'B', isActive: true, updatedAt: timestamp },
    ]);

    const result = await service.list('branches', { pageSize: 2, currentItem: 4 } as any);

    expect(result.total).toBe(7);
    expect(result.pageSize).toBe(2);
    expect(result.currentItem).toBe(4);
    expect(result.data).toHaveLength(2);
    expect(typeof result.timestamp).toBe('string');
  });

  it('phân trang bằng currentItem/pageSize và luôn chốt id làm khoá phụ', async () => {
    const { service, prisma } = createService();
    prisma.branch.count.mockResolvedValue(0);
    prisma.branch.findMany.mockResolvedValue([]);

    await service.list('branches', { pageSize: 20, currentItem: 40 } as any);

    expect(prisma.branch.findMany).toHaveBeenCalledWith({
      where: { AND: [{ isActive: true }] },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      skip: 40,
      take: 20,
    });
  });

  it('lọc delta sync theo lastModifiedFrom trên cột updatedAt', async () => {
    const { service, prisma } = createService();
    prisma.customer.count.mockResolvedValue(0);
    prisma.customer.findMany.mockResolvedValue([]);

    await service.list('customers', { lastModifiedFrom: timestamp.toISOString() } as any);

    expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [{ isActive: true }, { updatedAt: { gte: timestamp } }] },
    }));
  });

  it('ép pageSize về trần 100 để một client không kéo hết bảng trong một lần gọi', async () => {
    const { service, prisma } = createService();
    prisma.product.count.mockResolvedValue(0);
    prisma.product.findMany.mockResolvedValue([]);

    const result = await service.list('products', { pageSize: 5000 } as any);

    expect(result.pageSize).toBe(100);
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('áp orderDirection desc cho cả khoá chính lẫn khoá phụ', async () => {
    const { service, prisma } = createService();
    prisma.invoice.count.mockResolvedValue(0);
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.list('invoices', { orderBy: 'purchaseDate', orderDirection: 'desc' } as any);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ purchaseDate: 'desc' }, { id: 'desc' }],
    }));
  });

  it('ẩn các trường nhạy cảm và metadata đồng bộ nội bộ của khách hàng', async () => {
    const { service, prisma } = createService();
    prisma.customer.findUnique.mockResolvedValue({
      id: 7,
      name: 'Customer',
      identificationNumber: 'identity',
      invoiceCccdCmnd: 'cccd',
      invoiceBankAccount: 'account',
      kiotVietId: BigInt(99),
      larkSyncStatus: 'PENDING',
      createdBy: 1,
      customerGroupDetails: [{ customerGroup: { id: 3, name: 'VIP' } }],
      addresses: [],
      updatedAt: timestamp,
    });

    const result = await service.get('customers', 7);
    const customer = result.data as Record<string, unknown>;

    expect(customer).toMatchObject({ id: 7, name: 'Customer', groups: [{ id: 3, name: 'VIP' }] });
    expect(customer).not.toHaveProperty('identificationNumber');
    expect(customer).not.toHaveProperty('invoiceCccdCmnd');
    expect(customer).not.toHaveProperty('invoiceBankAccount');
    expect(customer).not.toHaveProperty('kiotVietId');
    expect(customer).not.toHaveProperty('larkSyncStatus');
    expect(customer).not.toHaveProperty('createdBy');
    expect(customer).not.toHaveProperty('customerGroupDetails');
  });

  it('trả lỗi not found nhất quán khi chi tiết resource không tồn tại', async () => {
    const { service, prisma } = createService();
    prisma.invoice.findUnique.mockResolvedValue(null);
    await expect(service.get('invoices', 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('không bao giờ đọc mật khẩu/cờ phân quyền của user ra Public API', async () => {
    const { service, prisma } = createService();
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);

    await service.list('users', {} as any);

    const [[args]] = prisma.user.findMany.mock.calls;
    // Chốt bằng select tường minh: dùng findMany trần rồi lọc sau sẽ rò ngay
    // khi schema User thêm cột nhạy cảm mới.
    expect(args.select).toEqual({
      id: true, name: true, email: true, phone: true, avatar: true,
      branchId: true, isActive: true, createdAt: true, updatedAt: true,
    });
    expect(args.select).not.toHaveProperty('password');
    expect(args.select).not.toHaveProperty('permissionVersion');
  });

  it('lọc phiếu chuyển theo cả chi nhánh gửi lẫn chi nhánh nhận', async () => {
    const { service, prisma } = createService();
    prisma.transfer.count.mockResolvedValue(0);
    prisma.transfer.findMany.mockResolvedValue([]);

    await service.list('transfers', { branchIds: '3,5' } as any);

    // Chỉ khớp fromBranchId sẽ giấu mất một nửa số phiếu mà chi nhánh liên quan.
    expect(prisma.transfer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [{ OR: [{ fromBranchId: { in: [3, 5] } }, { toBranchId: { in: [3, 5] } }] }] },
    }));
  });

  it('dùng đúng cột isActivate cho kênh bán hàng', async () => {
    const { service, prisma } = createService();
    prisma.saleChannel.count.mockResolvedValue(0);
    prisma.saleChannel.findMany.mockResolvedValue([]);

    await service.list('sale-channels', {} as any);

    expect(prisma.saleChannel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [{ isActivate: true }] },
    }));
  });

  it('ẩn metadata đồng bộ nội bộ của nhà cung cấp', async () => {
    const { service, prisma } = createService();
    prisma.supplier.findUnique.mockResolvedValue({
      id: 4, code: 'NCC01', name: 'Nhà cung cấp', isActive: true,
      kiotVietId: BigInt(12), lastSyncedAt: timestamp, createdBy: 9, createdName: 'Admin',
      updatedAt: timestamp,
    });

    const result = await service.get('suppliers', 4);
    const supplier = result.data as Record<string, unknown>;

    expect(supplier).toMatchObject({ id: 4, code: 'NCC01', name: 'Nhà cung cấp' });
    expect(supplier).not.toHaveProperty('kiotVietId');
    expect(supplier).not.toHaveProperty('lastSyncedAt');
    expect(supplier).not.toHaveProperty('createdBy');
    expect(supplier).not.toHaveProperty('createdName');
  });

  it('ánh xạ resource surchages sang model Surcharge của POS', async () => {
    const { service, prisma } = createService();
    prisma.surcharge.count.mockResolvedValue(1);
    prisma.surcharge.findMany.mockResolvedValue([
      { id: 2, code: 'PS01', name: 'Phí vận chuyển', kiotVietId: 5, lastSyncedAt: timestamp, updatedAt: timestamp },
    ]);

    const result = await service.list('surchages', {} as any);

    // Tên resource công khai theo KiotViet là `surchages` (thiếu chữ r), khác
    // tên model nội bộ `Surcharge`; giữ đúng để client KiotViet gọi được.
    expect(result.total).toBe(1);
    expect(result.data[0]).not.toHaveProperty('kiotVietId');
    expect(result.data[0]).toMatchObject({ code: 'PS01', name: 'Phí vận chuyển' });
  });

  it('ẩn người tạo và người duyệt trong phiếu trả nhà cung cấp', async () => {
    const { service, prisma } = createService();
    prisma.supplierReturn.findUnique.mockResolvedValue({
      id: 8, code: 'TNCC01', status: 1, createdBy: 3, createdByName: 'Admin',
      exportedById: 4, exportedByName: 'Kho', refundConfirmedBy: 5,
      refundConfirmedByName: 'Kế toán', updatedAt: timestamp,
    });

    const result = await service.get('supplier-returns', 8);
    const row = result.data as Record<string, unknown>;

    expect(row).toMatchObject({ id: 8, code: 'TNCC01' });
    for (const field of ['createdBy', 'createdByName', 'exportedById', 'exportedByName', 'refundConfirmedBy', 'refundConfirmedByName']) {
      expect(row).not.toHaveProperty(field);
    }
  });
});
