import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SaleReportsService } from './sale-reports.service';
import { ProductReportsService } from './product-reports.service';
import { SupplierReportsService } from './supplier-reports.service';
import { FinancialReportsService } from './financial-reports.service';
import { EodReportsService } from './eod-reports.service';
import { CustomerReportsService } from './customer-reports.service';
import { AnalyticsReportsService } from './analytics-reports.service';
import { AnalyticsConfigService } from './analytics-config.service';
import { AnalyticsKinhDoanhController } from './analytics/analytics-kinh-doanh.controller';
import { AnalyticsKinhDoanhService } from './analytics/analytics-kinh-doanh.service';
import { AnalyticsQuanTriController } from './analytics/analytics-quan-tri.controller';
import { AnalyticsQuanTriService } from './analytics/analytics-quan-tri.service';
import { AnalyticsKhachHangController } from './analytics/analytics-khach-hang.controller';
import { AnalyticsKhachHangService } from './analytics/analytics-khach-hang.service';
import { AnalyticsKhachHangDlclController } from './analytics/analytics-khach-hang-dlcl.controller';
import { AnalyticsKhachHangDlclService } from './analytics/analytics-khach-hang-dlcl.service';
import { AnalyticsDinhKiController } from './analytics/analytics-dinh-ki.controller';
import { AnalyticsDinhKiService } from './analytics/analytics-dinh-ki.service';
import { AnalyticsKeToanController } from './analytics/analytics-ke-toan.controller';
import { AnalyticsKeToanService } from './analytics/analytics-ke-toan.service';
import { AnalyticsMuaHangController } from './analytics/analytics-mua-hang.controller';
import { AnalyticsMuaHangService } from './analytics/analytics-mua-hang.service';
import { AnalyticsKpiSaleController } from './analytics/analytics-kpi-sale.controller';
import { AnalyticsKpiSaleService } from './analytics/analytics-kpi-sale.service';
import { ReportsPermissionGuard } from './reports-permission.guard';
import {
  AnalyticsCacheInterceptor,
  AnalyticsCacheService,
} from './analytics/analytics-cache';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    ReportsController,
    AnalyticsKinhDoanhController,
    AnalyticsQuanTriController,
    AnalyticsKhachHangController,
    AnalyticsKhachHangDlclController,
    AnalyticsDinhKiController,
    AnalyticsKeToanController,
    AnalyticsMuaHangController,
    AnalyticsKpiSaleController,
  ],
  providers: [
    ReportsService,
    SaleReportsService,
    ProductReportsService,
    SupplierReportsService,
    FinancialReportsService,
    EodReportsService,
    CustomerReportsService,
    AnalyticsReportsService,
    AnalyticsConfigService,
    AnalyticsKinhDoanhService,
    AnalyticsQuanTriService,
    AnalyticsKhachHangService,
    AnalyticsKhachHangDlclService,
    AnalyticsDinhKiService,
    AnalyticsKeToanService,
    AnalyticsMuaHangService,
    AnalyticsKpiSaleService,
    ReportsPermissionGuard,
    AnalyticsCacheService,
    AnalyticsCacheInterceptor,
  ],
})
export class ReportsModule {}
