import { Module } from '@nestjs/common';
import { InternalUseController } from './internal-use.controller';
import { InternalUseService } from './internal-use.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [InternalUseController],
  providers: [InternalUseService],
  exports: [InternalUseService],
})
export class InternalUseModule {}
