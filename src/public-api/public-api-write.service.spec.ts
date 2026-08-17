import { PublicApiWriteService } from './public-api-write.service';

describe('PublicApiWriteService', () => {
  const createService = () => {
    const customersService: any = {
      create: jest.fn(), update: jest.fn(), remove: jest.fn().mockResolvedValue({}),
    };
    const productsService: any = { create: jest.fn(), update: jest.fn() };
    const categoriesService: any = { create: jest.fn(), update: jest.fn() };
    const ordersService: any = { create: jest.fn(), update: jest.fn(), cancelOrder: jest.fn() };
    const invoicesService: any = { create: jest.fn(), update: jest.fn() };
    const publicApiService: any = {
      toPublicResource: jest.fn((_resource: string, row: unknown) => row),
    };
    return {
      customersService,
      productsService,
      categoriesService,
      ordersService,
      invoicesService,
      publicApiService,
      service: new PublicApiWriteService(
        customersService,
        productsService,
        categoriesService,
        ordersService,
        invoicesService,
        publicApiService,
      ),
    };
  };

  it('gọi lại CustomersService của POS thay vì tự dựng logic nghiệp vụ', async () => {
    const { service, customersService } = createService();
    const dto = { name: 'Khách A', addresses: [{ address: 'Số 1' }] } as any;
    customersService.create.mockResolvedValue({ id: 9, name: 'Khách A' });

    await service.createCustomer(dto);

    // Đi đúng một đường xử lý với thao tác của nhân viên trên giao diện POS.
    expect(customersService.create).toHaveBeenCalledWith(dto, 1);
  });

  it('luôn truyền userId để POS ghi được nhật ký', async () => {
    const { service, customersService } = createService();
    customersService.update.mockResolvedValue({ id: 9 });

    await service.updateCustomer(9, { name: 'Khách B' } as any);

    const [, userId] = customersService.update.mock.calls[0].slice(1);
    expect(userId).toBe(1);
  });

  it('áp cùng phép chiếu công khai như đường đọc để không rò trường nhạy cảm', async () => {
    const { service, customersService, publicApiService } = createService();
    customersService.create.mockResolvedValue({ id: 9, identificationNumber: 'cccd' });

    await service.createCustomer({ name: 'Khách A' } as any);

    expect(publicApiService.toPublicResource).toHaveBeenCalledWith('customers', { id: 9, identificationNumber: 'cccd' });
  });

  it('xoá khách hàng là ngừng hoạt động, không xoá bản ghi', async () => {
    const { service, customersService } = createService();

    const result = await service.deactivateCustomer(9);

    // CustomersService.remove đặt isActive = false; dữ liệu vẫn tra cứu được.
    expect(customersService.remove).toHaveBeenCalledWith(9, 1);
    expect(result.message).toContain('Ngừng hoạt động');
  });

  it('gọi ProductsService để tạo sản phẩm, không tự viết logic kho', async () => {
    const { service, productsService } = createService();
    const dto = { code: 'API-SP-001', name: 'Sản phẩm từ API', basePrice: 10000 } as any;
    productsService.create.mockResolvedValue({ id: 15, ...dto });

    await service.createProduct(dto);

    expect(productsService.create).toHaveBeenCalledWith(dto, 1);
  });

  it('ngừng kinh doanh sản phẩm bằng update isActive=false, không gọi remove xóa cứng', async () => {
    const { service, productsService } = createService();
    productsService.update.mockResolvedValue({ id: 15, isActive: false });

    await service.deactivateProduct(15);

    expect(productsService.update).toHaveBeenCalledWith(15, { isActive: false }, 1);
    expect(productsService).not.toHaveProperty('remove');
  });

  it('gọi OrdersService.create dưới acting user và chuẩn hóa kết quả', async () => {
    const { service, ordersService } = createService();
    ordersService.create.mockResolvedValue({ order: { id: 21, code: 'DH000021' }, warnings: ['thiếu tồn'] });

    const result = await service.createOrder({ branchId: 1, customerId: 2, items: [] } as any);

    expect(ordersService.create).toHaveBeenCalledWith({ branchId: 1, customerId: 2, items: [] }, 1);
    expect(result.data).toEqual({ id: 21, code: 'DH000021' });
    expect(result.warnings).toEqual(['thiếu tồn']);
  });

  it('update order truyền user object cần cho audit log', async () => {
    const { service, ordersService } = createService();
    ordersService.update.mockResolvedValue({ id: 21 });

    await service.updateOrder(21, { description: 'Cập nhật từ API' } as any);

    expect(ordersService.update).toHaveBeenCalledWith(21, { description: 'Cập nhật từ API' }, {
      id: 1, name: 'Public API', email: 'public-api@system.local',
    });
  });

  it('hủy order gọi cancelOrder thay vì tự sửa trạng thái', async () => {
    const { service, ordersService } = createService();
    ordersService.cancelOrder.mockResolvedValue({ message: 'Hủy đơn hàng thành công' });

    await service.cancelOrder(21, { cancelPayments: true });

    expect(ordersService.cancelOrder).toHaveBeenCalledWith(21, { cancelPayments: true }, 1);
  });

  it('hủy invoice dùng status cancelled và không hard-delete', async () => {
    const { service, invoicesService } = createService();
    invoicesService.update.mockResolvedValue({ id: 31, status: 2 });

    await service.cancelInvoice(31, true);

    expect(invoicesService.update).toHaveBeenCalledWith(31, { status: 2, cancelPayments: true }, 1);
    expect(invoicesService).not.toHaveProperty('remove');
  });

  it('gọi InvoicesService.create dưới acting user', async () => {
    const { service, invoicesService } = createService();
    invoicesService.create.mockResolvedValue({ id: 31, code: 'HD000031' });

    await service.createInvoice({ branchId: 1, items: [] } as any);

    expect(invoicesService.create).toHaveBeenCalledWith({ branchId: 1, items: [] }, 1);
  });

  it('gọi CategoriesService có sẵn cho create/update category', async () => {
    const { service, categoriesService } = createService();
    categoriesService.create.mockResolvedValue({ id: 5, name: 'API Nhóm', type: 'child' });
    categoriesService.update.mockResolvedValue({ id: 5, name: 'API Nhóm mới', type: 'child' });

    await service.createCategory({ name: 'API Nhóm', type: 'child' });
    await service.updateCategory(5, { name: 'API Nhóm mới' });

    expect(categoriesService.create).toHaveBeenCalledWith({ name: 'API Nhóm', type: 'child' });
    expect(categoriesService.update).toHaveBeenCalledWith(5, { name: 'API Nhóm mới' });
  });
});
