import { Body, Controller, Delete, Get, Headers, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PublicApiAuthGuard } from './guards/public-api-auth.guard';
import { PublicApiAuditInterceptor } from './interceptors/public-api-audit.interceptor';
import { PublicApiListQueryDto } from './dto/public-api-list-query.dto';
import { PublicApiService } from './public-api.service';
import { PublicApiWebhookService } from './public-api-webhook.service';
import { PublicApiWriteService } from './public-api-write.service';
import { PublicApiIdempotencyService } from './public-api-idempotency.service';
import { RegisterWebhookDto } from './dto/register-webhook.dto';
import { CreateCustomerDto, UpdateCustomerDto } from '../customers/dto';
import { CreateProductDto, UpdateProductDto } from '../products/dto';
import { CreateOrderDto, UpdateOrderDto } from '../orders/dto';
import { CancelOrderDto } from '../orders/dto/cancel-order.dto';
import { CreateInvoiceDto } from '../invoices/dto/create-invoice.dto';
import { UpdateInvoiceDto } from '../invoices/dto/update-invoice.dto';
import { IsIn, IsOptional, IsString, IsBoolean } from 'class-validator';
import { PublicCustomerLedgerQueryDto } from './dto/public-customer-ledger-query.dto';

class PublicInvoiceCancelDto {
  @IsOptional()
  @IsBoolean()
  cancelPayments?: boolean;
}

class PublicCategoryWriteDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsIn(['parent', 'middle', 'child'])
  type?: 'parent' | 'middle' | 'child';
}

@Public()
// KiotViet giới hạn 5000 request/giờ cho các hàm GET; áp cùng ngưỡng để đối tác
// đã quen KiotViet không phải chỉnh lại client. UserThrottlerGuard đếm theo `sub`
// của token nên mỗi client OAuth có bucket riêng, không đụng hạn mức của POS.
@Throttle({ default: { limit: 5000, ttl: 3600000 } })
@UseGuards(PublicApiAuthGuard)
@UseInterceptors(PublicApiAuditInterceptor)
@Controller('public/v1')
export class PublicApiController {
  constructor(
    private readonly publicApiService: PublicApiService,
    private readonly webhookService: PublicApiWebhookService,
    private readonly writeService: PublicApiWriteService,
    private readonly idempotency: PublicApiIdempotencyService,
  ) {}

  // ── Ghi ────────────────────────────────────────────────────────────────
  // Đặt trước các route động `:resource` để không bị nuốt mất.

  @Post('customers')
  createCustomer(
    @Req() request: any,
    @Body() dto: CreateCustomerDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'POST', path: '/customers', body: dto },
      () => this.writeService.createCustomer(dto),
    );
  }

  @Put('customers/:id')
  updateCustomer(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/customers/${id}`, body: dto },
      () => this.writeService.updateCustomer(id, dto),
    );
  }

  @Delete('customers/:id')
  deactivateCustomer(@Param('id', ParseIntPipe) id: number) {
    return this.writeService.deactivateCustomer(id);
  }

  @Post('products')
  createProduct(
    @Req() request: any,
    @Body() dto: CreateProductDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'POST', path: '/products', body: dto },
      () => this.writeService.createProduct(dto),
    );
  }

  @Put('products/:id')
  updateProduct(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/products/${id}`, body: dto },
      () => this.writeService.updateProduct(id, dto),
    );
  }

  // Không dùng DELETE vì ProductsService.remove xóa cứng. Đường này chỉ ngừng
  // kinh doanh sản phẩm bằng isActive=false, giữ lịch sử bán hàng/tồn kho.
  @Post('products/:id/deactivate')
  deactivateProduct(@Param('id', ParseIntPipe) id: number) {
    return this.writeService.deactivateProduct(id);
  }

  @Post('categories')
  createCategory(
    @Req() request: any,
    @Body() dto: PublicCategoryWriteDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'POST', path: '/categories', body: dto },
      () => this.writeService.createCategory({ name: dto.name, type: dto.type ?? 'child' }),
    );
  }

  @Put('categories/:id')
  updateCategory(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublicCategoryWriteDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/categories/${id}`, body: dto },
      () => this.writeService.updateCategory(id, dto),
    );
  }

  @Post('orders')
  createOrder(
    @Req() request: any,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'POST', path: '/orders', body: dto },
      () => this.writeService.createOrder(dto),
    );
  }

  @Put('orders/:id')
  updateOrder(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/orders/${id}`, body: dto },
      () => this.writeService.updateOrder(id, dto),
    );
  }

  @Put('orders/:id/cancel')
  cancelOrder(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/orders/${id}/cancel`, body: dto },
      () => this.writeService.cancelOrder(id, dto),
    );
  }

  @Post('invoices')
  createInvoice(
    @Req() request: any,
    @Body() dto: CreateInvoiceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'POST', path: '/invoices', body: dto },
      () => this.writeService.createInvoice(dto),
    );
  }

  @Put('invoices/:id')
  updateInvoice(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInvoiceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/invoices/${id}`, body: dto },
      () => this.writeService.updateInvoice(id, dto),
    );
  }

  @Put('invoices/:id/cancel')
  cancelInvoice(
    @Req() request: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublicInvoiceCancelDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotency.run(
      { clientId: request.publicApiClient.id, key: idempotencyKey, method: 'PUT', path: `/invoices/${id}/cancel`, body: dto },
      () => this.writeService.cancelInvoice(id, dto.cancelPayments),
    );
  }


  registerWebhook(@Req() request: any, @Body() dto: RegisterWebhookDto) {
    return this.webhookService.register(request.publicApiClient.id, dto);
  }

  @Get('webhooks')
  listWebhooks(@Req() request: any) {
    return this.webhookService.list(request.publicApiClient.id);
  }

  @Get('webhooks/:id')
  getWebhook(@Req() request: any, @Param('id') id: string) {
    return this.webhookService.get(request.publicApiClient.id, id);
  }

  @Delete('webhooks/:id')
  unregisterWebhook(@Req() request: any, @Param('id') id: string) {
    return this.webhookService.unregister(request.publicApiClient.id, id);
  }

  @Get('customers/:id/addresses')
  customerAddresses(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.listCustomerAddresses(id);
  }

  @Get('customers/:id/groups')
  customerGroups(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.listCustomerGroupMemberships(id);
  }

  @Get('customers/:id/ledger')
  customerLedger(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PublicCustomerLedgerQueryDto,
  ) {
    return this.publicApiService.getCustomerLedger(id, query);
  }

  @Get('orders/:id/payments')
  orderPayments(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.listOrderPayments(id);
  }

  @Get('invoices/:id/payments')
  invoicePayments(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.listInvoicePayments(id);
  }

  @Get('orders/:id/delivery')
  orderDelivery(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.getOrderDelivery(id);
  }

  @Get('invoices/:id/delivery')
  invoiceDelivery(@Param('id', ParseIntPipe) id: number) {
    return this.publicApiService.getInvoiceDelivery(id);
  }

  @Get(':resource')
  list(@Param('resource') resource: string, @Query() query: PublicApiListQueryDto) {
    return this.publicApiService.list(this.publicApiService.assertResource(resource), query);
  }

  @Get(':resource/:id')
  get(
    @Param('resource') resource: string,
    @Param('id', ParseIntPipe) id: number,
    @Query('include') include?: string,
  ) {
    return this.publicApiService.get(this.publicApiService.assertResource(resource), id, include);
  }
}
