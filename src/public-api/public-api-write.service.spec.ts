import { PublicApiWriteService } from './public-api-write.service';

describe('PublicApiWriteService', () => {
  const createService = () => {
    const customersService: any = {
      create: jest.fn(), update: jest.fn(), remove: jest.fn().mockResolvedValue({}),
    };
    const productsService: any = { create: jest.fn(), update: jest.fn() };
    const categoriesService: any = { create: jest.fn(), update: jest.fn() };
    const publicApiService: any = {
      toPublicResource: jest.fn((_resource: string, row: unknown) => row),
    };
    return {
      customersService,
      productsService,
      categoriesService,
      publicApiService,
      service: new PublicApiWriteService(
        customersService,
        productsService,
        categoriesService,
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
