import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { LarkOrderSyncService } from './services/lark-order-sync.service';
import { LarkCustomerSyncService } from './services/lark-customer-sync.service';
import { Public } from 'src/auth/decorators/public.decorator';

@ApiTags('Lark Sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lark-sync')
export class LarkSyncController {
  constructor(
    private readonly orderSync: LarkOrderSyncService,
    private readonly customerSync: LarkCustomerSyncService,
  ) {}

  @Post('orders/full')
  @ApiOperation({ summary: 'Full sync orders to Lark (3 tháng)' })
  async fullSyncOrders() {
    const result = await this.orderSync.fullSync();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }

  @Post('orders/retry')
  @ApiOperation({ summary: 'Retry failed order syncs' })
  async retryOrders() {
    const result = await this.orderSync.syncPendingAndFailed();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }

  @Public()
  @Post('orders/sync-now')
  @ApiOperation({
    summary: 'Sync tất cả orders lên Lark ngay lập tức (3 tháng)',
  })
  async syncNow() {
    const result = await this.orderSync.syncPendingAndFailed();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }

  @Post('customers/full')
  @ApiOperation({
    summary: 'Full sync khách hàng đang hoạt động lên Lark',
  })
  async fullSyncCustomers() {
    const result = await this.customerSync.fullSync();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }

  @Post('customers/retry')
  @ApiOperation({ summary: 'Retry các khách hàng PENDING/FAILED' })
  async retryCustomers() {
    const result = await this.customerSync.syncPendingAndFailed();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }

  @Public()
  @Post('customers/sync-now')
  @ApiOperation({
    summary: 'Sync khách hàng PENDING/FAILED lên Lark ngay lập tức',
  })
  async syncCustomersNow() {
    const result = await this.customerSync.syncPendingAndFailed();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }
}
