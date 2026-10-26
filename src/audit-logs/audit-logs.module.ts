import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';
import { SecurityAuditService } from './security-audit.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService, SecurityAuditService],
  exports: [AuditLogsService, SecurityAuditService],
})
export class AuditLogsModule {}
