import { Injectable } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import { CreateCustomerDto, UpdateCustomerDto } from '../customers/dto';
import { ProductsService } from '../products/products.service';
import { CreateProductDto, UpdateProductDto } from '../products/dto';
import { CategoriesService, CategoryType } from '../categories/categories.service';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto, UpdateOrderDto } from '../orders/dto';
import { CancelOrderDto } from '../orders/dto/cancel-order.dto';
import { InvoicesService } from '../invoices/invoices.service';
import { CreateInvoiceDto } from '../invoices/dto/create-invoice.dto';
import { UpdateInvoiceDto } from '../invoices/dto/update-invoice.dto';
import { INVOICE_STATUS } from '../invoices/dto/invoice-status.constants';
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
    private readonly ordersService: OrdersService,
    private readonly invoicesService: InvoicesService,
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
   * Tạo đơn hàng. `OrdersService.create` sinh mã đơn bằng `max(id) + 1`, nên hai
   * request Public API chạy song song có thể ra cùng mã và vi phạm ràng buộc
   * unique. Xếp hàng các lệnh tạo đơn của Public API để tránh việc đó mà không
   * phải sửa service POS.
   */
  async createOrder(dto: CreateOrderDto) {
    const result = await this.withLock('order', () =>
      this.ordersService.create(dto, this.actingUserId),
    );
    // OrdersService trả { order, warnings }; warnings gồm cảnh báo thiếu tồn kho.
    return {
      data: this.publicApiService.toPublicResource('orders', (result as any).order),
      warnings: (result as any).warnings ?? [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * `OrdersService.update` cần cả object user cho nhật ký, không chỉ id.
   * Gửi `items` là thay toàn bộ dòng hàng chứ không phải vá từng dòng.
   */
  async updateOrder(id: number, dto: UpdateOrderDto) {
    const result = await this.ordersService.update(id, dto, {
      id: this.actingUserId,
      name: 'Public API',
      email: 'public-api@system.local',
    });
    const order = (result as any)?.order ?? result;
    return {
      data: this.publicApiService.toPublicResource('orders', order),
      warnings: (result as any)?.warnings ?? [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Hủy đơn. POS chặn hủy khi đơn còn hóa đơn chưa hủy, nên đối tác phải hủy
   * hóa đơn trước. `cancelPayments` quyết định có hủy luôn phiếu thu và dòng
   * tiền hay không; không truyền thì tiền đã thu vẫn giữ nguyên.
   */
  async cancelOrder(id: number, dto: CancelOrderDto) {
    const result = await this.ordersService.cancelOrder(id, dto, this.actingUserId);
    return { ...result, timestamp: new Date().toISOString() };
  }

  /**
   * Tạo hóa đơn: trừ kho, ghi thẻ kho, sinh phiếu thu và cập nhật công nợ.
   * Cũng xếp hàng như đơn hàng vì mã hóa đơn được sinh theo mã lớn nhất hiện có.
   */
  async createInvoice(dto: CreateInvoiceDto) {
    const invoice = await this.withLock('invoice', () =>
      this.invoicesService.create(dto, this.actingUserId),
    );
    return this.present('invoices', invoice);
  }

  async updateInvoice(id: number, dto: UpdateInvoiceDto) {
    const invoice = await this.invoicesService.update(id, dto, this.actingUserId);
    return this.present('invoices', invoice);
  }

  /**
   * Hủy hóa đơn đi qua đúng nhánh hủy của POS: hoàn tồn kho, gỡ khuyến mãi,
   * tính lại công nợ. Không dùng `InvoicesService.remove` vì lệnh đó xóa cứng.
   */
  async cancelInvoice(id: number, cancelPayments?: boolean) {
    const invoice = await this.invoicesService.update(
      id,
      { status: INVOICE_STATUS.CANCELLED, cancelPayments } as UpdateInvoiceDto,
      this.actingUserId,
    );
    return this.present('invoices', invoice);
  }

  /**
   * Hàng đợi theo tiến trình cho các lệnh tạo dễ đụng mã trùng.
   *
   * Chỉ chặn được request đến từ Public API và chỉ trong một tiến trình Node.
   * Nếu backend chạy nhiều bản sao thì cần khóa ở tầng cơ sở dữ liệu; khi đó
   * `Idempotency-Key` vẫn là lớp bảo vệ chính chống gửi lại trùng.
   */
  private locks: Record<'order' | 'invoice', Promise<unknown>> = {
    order: Promise.resolve(),
    invoice: Promise.resolve(),
  };

  private async withLock<T>(name: 'order' | 'invoice', operation: () => Promise<T>): Promise<T> {
    const previous = this.locks[name];
    let release!: () => void;
    this.locks[name] = new Promise<void>((resolve) => (release = resolve));
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Trả về đúng hình dạng của đường đọc: đối tác tạo xong rồi đọc lại không gặp
   * hai cấu trúc khác nhau, và các trường nhạy cảm cũng bị lọc y hệt.
   */
  private present(
    resource: 'customers' | 'products' | 'categories' | 'orders' | 'invoices',
    row: unknown,
  ) {
    return {
      data: this.publicApiService.toPublicResource(resource, row),
      timestamp: new Date().toISOString(),
    };
  }
}
