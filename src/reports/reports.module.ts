import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SaleReportsService } from './sale-reports.service';
import { ProductReportsService } from './product-reports.service';
import { SupplierReportsService } from './supplier-reports.service';
import { FinancialReportsService } from './financial-reports.service';
import { EodReportsService } from './eod-reports.service';
import { CustomerReportsService } from './customer-reports.service';
import { ReportsPermissionGuard } from './reports-permission.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    SaleReportsService,
    ProductReportsService,
    SupplierReportsService,
    FinancialReportsService,
    EodReportsService,
    CustomerReportsService,
    ReportsPermissionGuard,
  ],
})
export class ReportsModule {}
