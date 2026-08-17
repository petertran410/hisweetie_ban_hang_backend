import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CustomersModule } from '../customers/customers.module';
import { ProductsModule } from '../products/products.module';
import { CategoriesModule } from '../categories/categories.module';
import { OrdersModule } from '../orders/orders.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { PublicApiController } from './public-api.controller';
import { PublicApiOAuthController } from './public-api-oauth.controller';
import { PublicApiClientAdminController } from './public-api-client-admin.controller';
import { PublicApiService } from './public-api.service';
import { PublicApiAuthService } from './public-api-auth.service';
import { PublicApiClientAdminService } from './public-api-client-admin.service';
import { PublicApiWebhookService } from './public-api-webhook.service';
import { PublicApiWriteService } from './public-api-write.service';
import { PublicApiIdempotencyService } from './public-api-idempotency.service';
import { PublicApiRetentionService } from './public-api-retention.service';
import { PublicApiAuthGuard } from './guards/public-api-auth.guard';
import { PublicApiAuditInterceptor } from './interceptors/public-api-audit.interceptor';

@Module({
  // Chỉ import module nghiệp vụ để dùng lại service của POS; không sửa gì bên trong.
  imports: [
    JwtModule.register({}),
    CustomersModule,
    ProductsModule,
    CategoriesModule,
    OrdersModule,
    InvoicesModule,
  ],
  controllers: [
    PublicApiController,
    PublicApiOAuthController,
    PublicApiClientAdminController,
  ],
  providers: [
    PublicApiService,
    PublicApiAuthService,
    PublicApiClientAdminService,
    PublicApiWebhookService,
    PublicApiWriteService,
    PublicApiIdempotencyService,
    PublicApiRetentionService,
    PublicApiAuthGuard,
    PublicApiAuditInterceptor,
  ],
})
export class PublicApiModule {}
