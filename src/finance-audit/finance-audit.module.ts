import { Module } from '@nestjs/common';
import { FinanceAuditService } from './finance-audit.service';

/** Module lá: không phụ thuộc module nào khác (không vòng import). */
@Module({
  providers: [FinanceAuditService],
  exports: [FinanceAuditService],
})
export class FinanceAuditModule {}
