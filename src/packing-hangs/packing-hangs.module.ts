import { Module } from '@nestjs/common';
import { PackingHangsController } from './packing-hangs.controller';
import { PackingHangsService } from './packing-hangs.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [PackingHangsController],
  providers: [PackingHangsService],
  exports: [PackingHangsService],
})
export class PackingHangsModule {}
