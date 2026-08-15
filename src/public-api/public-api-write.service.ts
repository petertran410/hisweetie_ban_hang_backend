import { Injectable } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import { CreateCustomerDto, UpdateCustomerDto } from '../customers/dto';
import { ProductsService } from '../products/products.service';
import { CreateProductDto, UpdateProductDto } from '../products/dto';
import { CategoriesService, CategoryType } from '../categories/categories.service';
import { PublicApiService } from './public-api.service';

/**
 * Đường ghi của Public API.
 *
 * Chỉ GỌI LẠI service nghiệp vụ sẵn có của POS, tuyệt đối không dựng lại logic
 * kho / công nợ / khuyến mãi ở đây. Nhờ vậy dữ liệu do đối tác tạo đi qua đúng
 * một đường xử lý với dữ liệu do nhân viên tạo trên giao diện POS.
 */
@Injectable()
export class PublicApiWriteService {
  /**
   * Mọi thao tác của đối tác ghi nhật ký dưới danh nghĩa user này. POS bắt buộc
   * có `userId` vì các bảng nghiệp vụ tham chiếu khoá ngoại sang `users`.
   */
  private readonly actingUserId = Number(process.env.PUBLIC_API_ACTING_USER_ID || 1);

  constructor(
    private readonly customersService: CustomersService,
    private readonly productsService: ProductsService,
    private readonly categoriesService: CategoriesService,
    private readonly publicApiService: PublicApiService,
  ) {}

  async createCustomer(dto: CreateCustomerDto) {
    const customer = await this.customersService.create(dto, this.actingUserId);
    return this.present('customers', customer);
  }

  async updateCustomer(id: number, dto: UpdateCustomerDto) {
    const customer = await this.customersService.update(id, dto, this.actingUserId);
    return this.present('customers', customer);
  }

  /**
   * `CustomersService.remove` là ngừng hoạt động (`isActive = false`), không xoá
   * bản ghi, nên khách hàng vẫn tra cứu được qua `includeInactive=true`.
   */
  async deactivateCustomer(id: number) {
    await this.customersService.remove(id, this.actingUserId);
    return { message: 'Ngừng hoạt động khách hàng thành công', timestamp: new Date().toISOString() };
  }

  async createProduct(dto: CreateProductDto) {
    const product = await this.productsService.create(dto, this.actingUserId);
    return this.present('products', product);
  }

  async updateProduct(id: number, dto: UpdateProductDto) {
    const product = await this.productsService.update(id, dto, this.actingUserId);
    return this.present('products', product);
  }

  /**
   * POS xoá cứng sản phẩm nên Public API không mở DELETE. Ngừng kinh doanh đi
   * qua `isActive = false`, giữ nguyên lịch sử bán hàng và tồn kho đã ghi nhận.
   */
  async deactivateProduct(id: number) {
    const product = await this.productsService.update(
      id,
      { isActive: false } as UpdateProductDto,
      this.actingUserId,
    );
    return this.present('products', product);
  }

  async createCategory(dto: { name: string; type: CategoryType }) {
    const category = await this.categoriesService.create(dto);
    return this.present('categories', category);
  }

  async updateCategory(id: number, dto: { name?: string; type?: CategoryType }) {
    const category = await this.categoriesService.update(id, dto);
    return this.present('categories', category);
  }

  /**
   * Trả về đúng hình dạng của đường đọc: đối tác tạo xong rồi đọc lại không gặp
   * hai cấu trúc khác nhau, và các trường nhạy cảm cũng bị lọc y hệt.
   */
  private present(resource: 'customers' | 'products' | 'categories', row: unknown) {
    return {
      data: this.publicApiService.toPublicResource(resource, row),
      timestamp: new Date().toISOString(),
    };
  }
}
