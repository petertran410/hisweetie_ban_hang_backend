import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LarkSyncModule } from '../lark-sync/lark-sync.module';
import { TiktokEventsModule } from '../tiktok-events/tiktok-events.module';

@Module({
  imports: [PrismaModule, AuditLogsModule, LarkSyncModule, TiktokEventsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
