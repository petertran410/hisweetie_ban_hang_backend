import { Module } from '@nestjs/common';
import { FactoryProductsModule } from '../factory-products/factory-products.module';
import { MisaSyncModule } from '../misa-sync/misa-sync.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { UploadModule } from '../upload/upload.module';
import { ProductsModule } from '../products/products.module';
import { NewProductPriceController } from './new-product-price.controller';
import { NewProductPriceService } from './new-product-price.service';
import { NewProductPriceConfigService } from './new-product-price-config.service';
import { NewProductPriceNotifyService } from './new-product-price-notify.service';
import { NewProductPriceApplyService } from './new-product-price-apply.service';
import { NewProductPriceReminderCron } from './new-product-price-reminder.cron';

@Module({
  imports: [
    PrismaModule,
    AuditLogsModule,
    NotificationsModule,
    LarkSyncModule,
    UploadModule,
    ProductsModule,
    FactoryProductsModule,
    MisaSyncModule,
  ],
  controllers: [NewProductPriceController],
  providers: [
    NewProductPriceService,
    NewProductPriceConfigService,
    NewProductPriceNotifyService,
    NewProductPriceApplyService,
    NewProductPriceReminderCron,
  ],
})
export class NewProductPriceModule {}
