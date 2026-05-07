import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';

import { SyncKiotApiService } from './sync-kiot-api.service';
import { SyncKiotService } from './sync-kiot.service';
import { SyncKiotController } from './sync-kiot.controller';
import { SyncKiotScheduler } from './sync-kiot.scheduler';

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
import { SyncCashFlowService } from './services/sync-cashflow.service';
import { SyncTransferService } from './services/sync-transfer.service';
import { SyncOrderSupplierService } from './services/sync-order-supplier.service';
import { SyncPurchaseOrderService } from './services/sync-purchase-order.service';
import { SyncReturnOrderService } from './services/sync-return-order.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    HttpModule.register({ timeout: 30000, maxRedirects: 5 }),
  ],
  controllers: [SyncKiotController],
  providers: [
    SyncKiotApiService,
    SyncKiotService,
    SyncKiotScheduler,
    SyncBranchService,
    SyncUserService,
    SyncCustomerService,
    SyncProductService,
    SyncSupplierService,
    SyncSaleChannelService,
    SyncSurchargeService,
    SyncBankAccountService,
    SyncTradeMarkService,
    SyncCustomerGroupService,
    SyncPriceBookService,
    SyncOrderService,
    SyncInvoiceService,
    SyncCashFlowService,
    SyncTransferService,
    SyncPurchaseOrderService,
    SyncOrderSupplierService,
    SyncReturnOrderService,
  ],
  exports: [SyncKiotService],
})
export class SyncKiotModule {}
