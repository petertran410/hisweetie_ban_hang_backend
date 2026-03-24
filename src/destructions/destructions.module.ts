import { Module } from '@nestjs/common';
import { DestructionsController } from './destructions.controller';
import { DestructionsService } from './destructions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [DestructionsController],
  providers: [DestructionsService],
  exports: [DestructionsService],
})
export class DestructionsModule {}
