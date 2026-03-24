import { Module } from '@nestjs/common';
import { PackingSlipsController } from './packing-slips.controller';
import { PackingSlipsService } from './packing-slips.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PackingSlipsController],
  providers: [PackingSlipsService],
  exports: [PackingSlipsService],
})
export class PackingSlipsModule {}
