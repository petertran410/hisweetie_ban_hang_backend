import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { LarkOrderSyncService } from './services/lark-order-sync.service';

@ApiTags('Lark Sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lark-sync')
export class LarkSyncController {
  constructor(private readonly orderSync: LarkOrderSyncService) {}

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

  @Post('orders/sync-now')
  @ApiOperation({
    summary: 'Sync tất cả orders lên Lark ngay lập tức (3 tháng)',
  })
  async syncNow() {
    const result = await this.orderSync.syncPendingAndFailed();
    return { ok: true, ...result, timestamp: new Date().toISOString() };
  }
}
