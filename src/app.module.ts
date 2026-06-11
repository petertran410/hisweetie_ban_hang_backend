import { ReportsModule } from './reports/reports.module';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_PIPE, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { PermissionsModule } from './permissions/permissions.module';
import { ProductsModule } from './products/products.module';
import { ProductVariantsModule } from './product-variants/product-variants.module';
import { CategoriesModule } from './categories/categories.module';
import { CustomerTypesModule } from './customer-types/customer-types.module';
import { CustomersModule } from './customers/customers.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { OrdersModule } from './orders/orders.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { UploadModule } from './upload/upload.module';
import { UploadSessionModule } from './upload-session/upload-session.module';
import { ImportModule } from './import/import.module';
import { PdfModule } from './pdf/pdf.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PostsModule } from './posts/posts.module';
import { TagsModule } from './tags/tags.module';
import { PostMetaModule } from './post-meta/post-meta.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { BlockScannerMiddleware } from './common/middleware/block-scanner.middleware';
import { ValidationPipe } from '@nestjs/common';
import { TrademarksModule } from './trademarks/trademarks.module';
import { BranchesModule } from './branches/branches.module';
import { PriceBooksModule } from './price-books/price-books.module';
import { CustomerGroupsModule } from './customer-groups/customer-groups.module';
import { InventoriesModule } from './inventories/inventories.module';
import { SettingsModule } from './settings/settings.module';
import { TransfersModule } from './transfers/transfers.module';
import { SaleChannelsModule } from './sale-channels/sale-channels.module';
import { InvoicesModule } from './invoices/invoices.module';
import { CashFlowsModule } from './cashflows/cashflows.module';
import { CashFlowGroupsModule } from './cashflow-groups/cashflow-groups.module';
import { NoteTemplatesModule } from './note-templates/note-templates.module';
import { ProductionsModule } from './productions/productions.module';
import { DestructionsModule } from './destructions/destructions.module';
import { SupplierGroupsModule } from './supplier-groups/supplier-groups.module';
import { OrderSuppliersModule } from './order-suppliers/order-suppliers.module';
import { VehicleShipmentsModule } from './vehicle-shipments/vehicle-shipments.module';
import { BorderGatesModule } from './border-gates/border-gates.module';
import { PackingSlipsModule } from './packing-slips/packing-slips.module';
import { PackingHangsModule } from './packing-hangs/packing-hangs.module';
import { PackingLoadingsModule } from './packing-loadings/packing-loadings.module';
import { AllPackingModule } from './all-packing/all-packing.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { PrintTemplatesModule } from './print-templates/print-templates.module';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module';
import { ReturnOrdersModule } from './return-orders/return-orders.module';
import { CashFlowCollectionBranchesModule } from './cashflow-collection-branches/cashflow-collection-branches.module';
import { InventoryChecksModule } from './inventory-checks/inventory-checks.module';
import { StockAuditsModule } from './stock-audits/stock-audits.module';
import { PermissionCacheModule } from './permission-cache/permission-cache.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SyncKiotModule } from './sync-kiot/sync-kiot.module';
import { LarkSyncModule } from './lark-sync/lark-sync.module';
import { MisaSyncModule } from './misa-sync/misa-sync.module';
import { HealthController } from './health/health.controller';
import { SupplierReturnsModule } from './supplier-returns/supplier-returns.module';
import { UserBankAccountsModule } from './user-bank-accounts/user-bank-accounts.module';
import { SepayModule } from './sepay/sepay.module';
import { PromotionsModule } from './promotions/promotions.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        // Giới hạn mặc định toàn cục: 100 request / 60 giây / IP.
        // Đủ thoải mái cho người dùng thật, nhưng chặn bot quét hàng loạt.
        name: 'default',
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrismaModule,
    PermissionCacheModule,
    AuthModule,
    UsersModule,
    RolesModule,
    AuditLogsModule,
    PrintTemplatesModule,
    PermissionsModule,
    ProductsModule,
    ProductVariantsModule,
    BranchesModule,
    InventoriesModule,
    SettingsModule,
    CategoriesModule,
    TrademarksModule,
    CustomerTypesModule,
    CustomersModule,
    CustomerGroupsModule,
    SuppliersModule,
    OrdersModule,
    InvoicesModule,
    PurchaseOrdersModule,
    PriceBooksModule,
    ReportsModule,
    UploadModule,
    UploadSessionModule,
    // ExportModule,
    ImportModule,
    PdfModule,
    AnalyticsModule,
    DashboardModule,
    PostsModule,
    TagsModule,
    PostMetaModule,
    TransfersModule,
    SaleChannelsModule,
    CashFlowsModule,
    CashFlowGroupsModule,
    NoteTemplatesModule,
    ProductionsModule,
    DestructionsModule,
    SupplierGroupsModule,
    OrderSuppliersModule,
    VehicleShipmentsModule,
    BorderGatesModule,
    PackingSlipsModule,
    PackingHangsModule,
    PackingLoadingsModule,
    AllPackingModule,
    BankAccountsModule,
    UserBankAccountsModule,
    ReturnOrdersModule,
    InventoryChecksModule,
    StockAuditsModule,
    CashFlowCollectionBranchesModule,
    SyncKiotModule,
    LarkSyncModule,
    MisaSyncModule,
    SupplierReturnsModule,
    SepayModule,
    PromotionsModule,
    NotificationsModule,
  ],
  providers: [
    {
      // Chạy đầu tiên: chặn flood/quét theo IP trước khi vào xác thực.
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Chặn quét trên toàn bộ route (kể cả ngoài prefix /api).
    consumer.apply(BlockScannerMiddleware).forRoutes('*');
  }
}
