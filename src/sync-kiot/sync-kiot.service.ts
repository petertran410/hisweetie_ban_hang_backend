import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncKiotApiService } from './sync-kiot-api.service';
import { SyncBranchService } from './services/sync-branch.service';
import { SyncUserService } from './services/sync-user.service';
import { SyncCustomerService } from './services/sync-customer.service';
import { SyncProductService } from './services/sync-product.service';
import { SyncSupplierService } from './services/sync-supplier.service';
import { SyncSaleChannelService } from './services/sync-sale-channel.service';
import { SyncSurchargeService } from './services/sync-surcharge.service';
import { SyncBankAccountService } from './services/sync-bank-account.service';
import { SyncTradeMarkService } from './services/sync-trade-mark.service';
import { SyncCustomerGroupService } from './services/sync-customer-group.service';
import { SyncPriceBookService } from './services/sync-price-book.service';
import { SyncOrderService } from './services/sync-order.service';
import { SyncInvoiceService } from './services/sync-invoice.service';

@Injectable()
export class SyncKiotService {
  private readonly logger = new Logger(SyncKiotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncBranch: SyncBranchService,
    private readonly syncUser: SyncUserService,
    private readonly syncCustomer: SyncCustomerService,
    private readonly syncProduct: SyncProductService,
    private readonly syncSupplier: SyncSupplierService,
    private readonly syncSaleChannel: SyncSaleChannelService,
    private readonly syncSurcharge: SyncSurchargeService,
    private readonly syncBankAccount: SyncBankAccountService,
    private readonly syncTradeMark: SyncTradeMarkService,
    private readonly syncCustomerGroup: SyncCustomerGroupService,
    private readonly syncPriceBook: SyncPriceBookService,
    private readonly syncOrder: SyncOrderService,
    private readonly syncInvoice: SyncInvoiceService,
  ) {}

  /**
   * Full sync — chạy 1 lần ban đầu hoặc khi cần reset
   */
  async runFullSync(): Promise<Record<string, any>> {
    this.logger.log('🚀 Starting FULL sync from sync_kiot_data...');
    const results: Record<string, any> = {};

    // LAYER 1: Dữ liệu nền tảng (tuần tự)
    results.branches = await this.safeSync('branch', () =>
      this.syncBranch.syncAll(),
    );
    results.users = await this.safeSync('user', () => this.syncUser.syncAll());
    results.saleChannels = await this.safeSync('sale_channel', () =>
      this.syncSaleChannel.syncAll(),
    );
    results.surcharges = await this.safeSync('surcharge', () =>
      this.syncSurcharge.syncAll(),
    );
    results.bankAccounts = await this.safeSync('bank_account', () =>
      this.syncBankAccount.syncAll(),
    );
    results.tradeMarks = await this.safeSync('trade_mark', () =>
      this.syncTradeMark.syncAll(),
    );
    results.customerGroups = await this.safeSync('customer_group', () =>
      this.syncCustomerGroup.syncAll(),
    );

    // LAYER 2: Phụ thuộc Layer 1 (tuần tự)
    results.customers = await this.safeSync('customer', () =>
      this.syncCustomer.syncAll(),
    );
    results.products = await this.safeSync('product', () =>
      this.syncProduct.syncAll(),
    );
    results.suppliers = await this.safeSync('supplier', () =>
      this.syncSupplier.syncAll(),
    );
    results.priceBooks = await this.safeSync('price_book', () =>
      this.syncPriceBook.syncAll(),
    );

    // LAYER 3: Giao dịch
    results.orders = await this.safeSync('order', () =>
      this.syncOrder.syncAll(),
    );
    results.invoices = await this.safeSync('invoice', () =>
      this.syncInvoice.syncAll(),
    );

    this.logger.log('✅ FULL sync completed');
    return results;
  }

  /**
   * Incremental sync — chạy hàng ngày, chỉ lấy thay đổi
   */
  async runIncrementalSync(): Promise<Record<string, any>> {
    this.logger.log('📦 Starting INCREMENTAL sync...');
    const results: Record<string, any> = {};

    // Layer 1
    results.branches = await this.safeSync('branch', () =>
      this.syncBranch.syncIncremental(),
    );
    results.users = await this.safeSync('user', () => this.syncUser.syncAll()); // User không có modifiedDate
    results.saleChannels = await this.safeSync('sale_channel', () =>
      this.syncSaleChannel.syncAll(),
    );
    results.surcharges = await this.safeSync('surcharge', () =>
      this.syncSurcharge.syncAll(),
    );

    // Layer 2
    results.customers = await this.safeSync('customer', () =>
      this.syncCustomer.syncIncremental(),
    );
    results.products = await this.safeSync('product', () =>
      this.syncProduct.syncIncremental(),
    );
    results.suppliers = await this.safeSync('supplier', () =>
      this.syncSupplier.syncIncremental(),
    );

    // Layer 3
    results.orders = await this.safeSync('order', () =>
      this.syncOrder.syncIncremental(),
    );
    results.invoices = await this.safeSync('invoice', () =>
      this.syncInvoice.syncIncremental(),
    );

    this.logger.log('✅ INCREMENTAL sync completed');
    return results;
  }

  /**
   * Sync 1 entity cụ thể (dùng cho webhook)
   */
  async syncSingleEntity(entityType: string, code: string): Promise<any> {
    switch (entityType) {
      case 'customer':
        return this.syncCustomer.syncByCode(code);
      case 'product':
        return this.syncProduct.syncByCode(code);
      case 'order':
        return this.syncOrder.syncByCode(code);
      case 'invoice':
        return this.syncInvoice.syncByCode(code);
      case 'supplier':
        return this.syncSupplier.syncByCode(code);
      default:
        this.logger.warn(`⚠️ Unknown entity type: ${entityType}`);
        return null;
    }
  }

  private async safeSync(
    entityType: string,
    fn: () => Promise<{ created: number; updated: number; skipped: number }>,
  ) {
    try {
      await this.updateSyncControl(entityType, 'running');
      const result = await fn();
      await this.updateSyncControl(
        entityType,
        'completed',
        null,
        result.created + result.updated,
      );
      return { success: true, ...result };
    } catch (error) {
      this.logger.error(`❌ Sync ${entityType} failed: ${error.message}`);
      await this.updateSyncControl(entityType, 'failed', error.message);
      return { success: false, error: error.message };
    }
  }

  private async updateSyncControl(
    entityType: string,
    status: string,
    error?: string | null,
    totalSynced?: number,
  ) {
    await this.prisma.syncControl.upsert({
      where: { entityType },
      create: {
        entityType,
        status,
        isRunning: status === 'running',
        lastSyncAt: status === 'completed' ? new Date() : undefined,
        error,
        totalSynced,
      },
      update: {
        status,
        isRunning: status === 'running',
        lastSyncAt: status === 'completed' ? new Date() : undefined,
        error: error ?? null,
        ...(totalSynced !== undefined ? { totalSynced } : {}),
      },
    });
  }
}
