import { Module } from '@nestjs/common';
import { PackingLoadingsController } from './packing-loadings.controller';
import { PackingLoadingsService } from './packing-loadings.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PackingLoadingsController],
  providers: [PackingLoadingsService],
  exports: [PackingLoadingsService],
})
export class PackingLoadingsModule {}
