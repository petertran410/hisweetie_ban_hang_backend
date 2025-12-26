import { Module } from '@nestjs/common';
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
// import { ReportsModule } from './reports/reports.module';
import { UploadModule } from './upload/upload.module';
// import { ExportModule } from './export/export.module';
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
import { ValidationPipe } from '@nestjs/common';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TrademarksModule } from './trademarks/trademarks.module';
import { BranchesModule } from './branches/branches.module';
import { PriceBooksModule } from './price-books/price-books.module';
import { CustomerGroupsModule } from './customer-groups/customer-groups.module';
import { InventoriesModule } from './inventories/inventories.module';
import { SettingsModule } from './settings/settings.module';
import { TransfersModule } from './transfers/transfers.module';
import { SaleChannelsModule } from './sale-channels/sale-channels.module';
import { InvoicesModule } from './invoices/invoices.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    RolesModule,
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
    // ReportsModule,
    UploadModule,
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
  ],
  providers: [
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
    {
      provide: APP_PIPE,
      useClass: ValidationPipe,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
