import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ProductsModule } from '../products/products.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';

@Module({
  imports: [
    MulterModule.register({
      limits: {
        fileSize: 100 * 1024 * 1024,
      },
    }),
    // Cần ProductsService.generateSafeProductCode() để tạo mã tự sinh
    // khi dòng Excel trống cột "Mã hàng".
    ProductsModule,
    // Cần AuditLogsService để ghi 1 audit log tổng cho cả file import.
    AuditLogsModule,
    // Cần LarkProductSyncService.enqueueSync() để đồng bộ sau khi commit.
    LarkSyncModule,
  ],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
