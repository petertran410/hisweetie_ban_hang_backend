import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { SaleReportsService } from './sale-reports.service';
import { ProductReportsService } from './product-reports.service';
import { SupplierReportsService } from './supplier-reports.service';
import { FinancialReportsService } from './financial-reports.service';
import { EodReportsService } from './eod-reports.service';
import { CustomerReportsService } from './customer-reports.service';
import {
  ReportQueryDto,
  SaleReportQueryDto,
  ProductReportQueryDto,
  SupplierReportQueryDto,
  FinancialReportQueryDto,
  EodReportQueryDto,
  CustomerReportQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsPermissionGuard } from './reports-permission.guard';
import { ReportPermission } from '../auth/decorators/report-permission.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ReportsPermissionGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    private reportsService: ReportsService,
    private saleReportsService: SaleReportsService,
    private productReportsService: ProductReportsService,
    private supplierReportsService: SupplierReportsService,
    private financialReportsService: FinancialReportsService,
    private eodReportsService: EodReportsService,
    private customerReportsService: CustomerReportsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM CUỐI NGÀY (EndOfDay)
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('eod/preview')
  @ReportPermission({ group: 'eod' })
  @ApiOperation({ summary: 'Báo cáo cuối ngày theo ViewType' })
  getEodPreview(@Query() query: EodReportQueryDto) {
    return this.eodReportsService.getPreview(query);
  }

  @Get('eod/export')
  @ReportPermission({ group: 'eod', exportKey: 'reports:export_eod' })
  @ApiOperation({ summary: 'Xuất Excel báo cáo cuối ngày' })
  async exportEod(@Query() query: EodReportQueryDto, @Res() res: Response) {
    await this.eodReportsService.exportExcel(query, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM TÀI CHÍNH (Financial)
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('financial/chart')
  @ReportPermission({ key: 'reports:financial' })
  @ApiOperation({ summary: 'Dữ liệu biểu đồ báo cáo tài chính' })
  getFinancialChart(@Query() query: FinancialReportQueryDto) {
    return this.financialReportsService.getChart(query);
  }

  @Get('financial/preview')
  @ReportPermission({ key: 'reports:financial' })
  @ApiOperation({ summary: 'Bảng dữ liệu báo cáo tài chính' })
  getFinancialPreview(@Query() query: FinancialReportQueryDto) {
    return this.financialReportsService.getPreview(query);
  }

  @Get('financial/cashflows')
  @ReportPermission({ key: 'reports:financial' })
  @ApiOperation({ summary: 'Drilldown: phiếu thu/chi' })
  getFinancialCashFlows(@Query() query: FinancialReportQueryDto) {
    return this.financialReportsService.getCashFlows(query);
  }

  @Get('financial/cashflows/export')
  @ReportPermission({
    key: 'reports:financial',
    exportKey: 'reports:export_financial',
  })
  @ApiOperation({ summary: 'Xuất Excel chi tiết phiếu thu/chi' })
  async exportFinancialDetail(
    @Query() query: FinancialReportQueryDto,
    @Res() res: Response,
  ) {
    await this.financialReportsService.exportCashFlowsDetail(query, res);
  }

  @Get('financial/export')
  @ReportPermission({
    key: 'reports:financial',
    exportKey: 'reports:export_financial',
  })
  @ApiOperation({ summary: 'Xuất Excel báo cáo tài chính' })
  async exportFinancial(
    @Query() query: FinancialReportQueryDto,
    @Res() res: Response,
  ) {
    await this.financialReportsService.exportExcel(query, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM NHÀ CUNG CẤP (Supplier)
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('supplier/chart')
  @ReportPermission({ group: 'supplier' })
  @ApiOperation({ summary: 'Dữ liệu biểu đồ báo cáo nhà cung cấp' })
  getSupplierChart(@Query() query: SupplierReportQueryDto) {
    return this.supplierReportsService.getChart(query);
  }

  @Get('supplier/preview')
  @ReportPermission({ group: 'supplier' })
  @ApiOperation({ summary: 'Bảng dữ liệu báo cáo nhà cung cấp' })
  getSupplierPreview(@Query() query: SupplierReportQueryDto) {
    return this.supplierReportsService.getPreview(query);
  }

  @Get('supplier/purchases')
  @ReportPermission({ group: 'supplier' })
  @ApiOperation({ summary: 'Drilldown: phiếu nhập của nhà cung cấp' })
  getSupplierPurchases(@Query() query: SupplierReportQueryDto) {
    return this.supplierReportsService.getSupplierPurchases(query);
  }

  @Get('supplier/purchases/export')
  @ReportPermission({ group: 'supplier', exportKey: 'reports:export_supplier' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết phiếu nhập' })
  async exportSupplierDetail(
    @Query() query: SupplierReportQueryDto,
    @Res() res: Response,
  ) {
    await this.supplierReportsService.exportPurchases(query, res);
  }

  @Get('supplier/export')
  @ReportPermission({ group: 'supplier', exportKey: 'reports:export_supplier' })
  @ApiOperation({ summary: 'Xuất Excel báo cáo nhà cung cấp' })
  async exportSupplier(
    @Query() query: SupplierReportQueryDto,
    @Res() res: Response,
  ) {
    await this.supplierReportsService.exportExcel(query, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM HÀNG HÓA (Product)
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('product/chart')
  @ReportPermission({ group: 'product' })
  @ApiOperation({ summary: 'Dữ liệu biểu đồ báo cáo hàng hóa' })
  getProductChart(@Query() query: ProductReportQueryDto) {
    return this.productReportsService.getChart(query);
  }

  @Get('product/preview')
  @ReportPermission({ group: 'product' })
  @ApiOperation({ summary: 'Bảng dữ liệu báo cáo hàng hóa theo ViewType' })
  getProductPreview(@Query() query: ProductReportQueryDto) {
    return this.productReportsService.getPreview(query);
  }

  @Get('product/invoices')
  @ReportPermission({ group: 'product' })
  @ApiOperation({ summary: 'Drilldown: dòng hóa đơn của sản phẩm' })
  getProductInvoices(@Query() query: ProductReportQueryDto) {
    return this.productReportsService.getProductInvoices(query);
  }

  @Get('product/invoices/export')
  @ReportPermission({ group: 'product', exportKey: 'reports:export_product' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết dòng hóa đơn hàng hóa' })
  async exportProductDetail(
    @Query() query: ProductReportQueryDto,
    @Res() res: Response,
  ) {
    await this.productReportsService.exportProductInvoices(query, res);
  }

  @Get('product/export')
  @ReportPermission({ group: 'product', exportKey: 'reports:export_product' })
  @ApiOperation({ summary: 'Xuất Excel báo cáo hàng hóa' })
  async exportProduct(
    @Query() query: ProductReportQueryDto,
    @Res() res: Response,
  ) {
    await this.productReportsService.exportExcel(query, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM BÁN HÀNG (Sale) — chart / preview / export theo ViewType
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('sale/chart')
  @ReportPermission({ group: 'sale' })
  @ApiOperation({ summary: 'Dữ liệu biểu đồ báo cáo bán hàng' })
  getSaleChart(@Query() query: SaleReportQueryDto) {
    return this.saleReportsService.getChart(query);
  }

  @Get('sale/preview')
  @ReportPermission({ group: 'sale' })
  @ApiOperation({ summary: 'Bảng dữ liệu báo cáo bán hàng theo ViewType' })
  getSalePreview(@Query() query: SaleReportQueryDto) {
    return this.saleReportsService.getPreview(query);
  }

  @Get('sale/profit-invoices')
  @ReportPermission({ group: 'sale' })
  @ApiOperation({
    summary: 'Drilldown: danh sách hóa đơn kèm giá vốn/lợi nhuận',
  })
  getSaleProfitInvoices(@Query() query: SaleReportQueryDto) {
    return this.saleReportsService.previewProfitInvoices(query);
  }

  @Get('sale/profit-invoices/export')
  @ReportPermission({ group: 'sale', exportKey: 'reports:export_sale' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết hóa đơn bán hàng' })
  async exportSaleDetail(
    @Query() query: SaleReportQueryDto,
    @Res() res: Response,
  ) {
    await this.saleReportsService.exportProfitInvoices(query, res);
  }

  @Get('sale/export')
  @ReportPermission({ group: 'sale', exportKey: 'reports:export_sale' })
  @ApiOperation({ summary: 'Xuất Excel báo cáo bán hàng' })
  async exportSale(@Query() query: SaleReportQueryDto, @Res() res: Response) {
    const filename = `bao-cao-ban-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.saleReportsService.exportExcel(query, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NHÓM KHÁCH HÀNG (Customer) — chuẩn hoá theo pattern Product
  // ═══════════════════════════════════════════════════════════════════════════
  @Get('customer/chart')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Dữ liệu biểu đồ báo cáo khách hàng (Top N)' })
  getCustomerChart(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getChart(query);
  }

  @Get('customer/preview')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Bảng dữ liệu báo cáo khách hàng theo ViewType' })
  getCustomerPreview(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getPreview(query);
  }

  @Get('customer/invoices')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Drilldown: dòng hóa đơn của 1 khách hàng' })
  getCustomerInvoices(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getCustomerInvoices(query);
  }

  @Get('customer/sale-invoices')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({
    summary:
      'Drilldown Lv2 (CustomerBySale): hóa đơn kèm doanh số/hàng trả/thuần',
  })
  getCustomerSaleInvoices(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getCustomerSaleInvoices(query);
  }

  @Get('customer/products')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Drilldown Lv2: sản phẩm 1 KH đã mua' })
  getCustomerProducts(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getCustomerProducts(query);
  }

  @Get('customer/debt-customers')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Drilldown Lv2: danh sách KH trong nhóm rank nợ' })
  getCustomerDebtCustomers(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getDebtCustomers(query);
  }

  @Get('customer/debt-documents')
  @ReportPermission({ group: 'customer' })
  @ApiOperation({ summary: 'Drilldown Lv3: chi tiết phát sinh công nợ 1 KH' })
  getCustomerDebtDocuments(@Query() query: CustomerReportQueryDto) {
    return this.customerReportsService.getDebtDocuments(query);
  }

  @Get('customer/export')
  @ReportPermission({ group: 'customer', exportKey: 'reports:export_customer' })
  @ApiOperation({ summary: 'Xuất Excel báo cáo khách hàng (tổng hợp)' })
  async exportCustomer(
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `bao-cao-khach-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.customerReportsService.exportExcel(query, res);
  }

  @Get('customer/invoices/export')
  @ReportPermission({ group: 'customer', exportKey: 'reports:export_customer' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết dòng hóa đơn theo KH' })
  async exportCustomerInvoices(
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `chi-tiet-khach-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.customerReportsService.exportCustomerInvoices(query, res);
  }

  @Get('customer/sale-invoices/export')
  @ReportPermission({ group: 'customer', exportKey: 'reports:export_customer' })
  @ApiOperation({
    summary: 'Xuất Excel chi tiết hóa đơn theo KH (doanh số/hàng trả/thuần)',
  })
  async exportCustomerSaleInvoices(
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `chi-tiet-ban-hang-theo-khach_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.customerReportsService.exportCustomerSaleInvoices(query, res);
  }

  @Get('customer/debt-documents/export')
  @ReportPermission({ group: 'customer', exportKey: 'reports:export_customer' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết công nợ 1 KH' })
  async exportCustomerDebtDocuments(
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `chi-tiet-cong-no-kh_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.customerReportsService.exportDebtDocuments(query, res);
  }

  @Get('customer/debt-documents/export-all')
  @ReportPermission({ group: 'customer', exportKey: 'reports:export_customer' })
  @ApiOperation({ summary: 'Xuất Excel chi tiết công nợ toàn bộ KH' })
  async exportCustomerDebtDocumentsAll(
    @Query() query: CustomerReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `chi-tiet-cong-no-toan-bo_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.customerReportsService.exportDebtDetail(query, res);
  }

  // ── Báo cáo 1: Preview (LEGACY — giữ tạm trong giai đoạn chuyển đổi) ──
  @Get('customer-sales')
  @ReportPermission({ key: 'reports:customer_sale' })
  @ApiOperation({ summary: 'Preview báo cáo bán hàng theo hóa đơn' })
  getCustomerSalesPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerSalesPreview(query);
  }

  @Get('customer-sales/chart')
  @ReportPermission({ key: 'reports:customer_sale' })
  @ApiOperation({ summary: 'Biểu đồ doanh thu theo khách (top 20)' })
  getCustomerSalesChart(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerSalesChart(query);
  }

  // ── Báo cáo 1: Export Excel ──
  @Get('customer-sales/export')
  @ReportPermission({
    key: 'reports:customer_sale',
    exportKey: 'reports:export_customer',
  })
  @ApiOperation({ summary: 'Xuất Excel báo cáo bán hàng' })
  async exportCustomerSales(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `bao-cao-ban-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportCustomerSales(query, res);
  }

  // ── Báo cáo 2: Preview ──
  @Get('product-by-customer')
  @ReportPermission({ key: 'reports:customer_product' })
  @ApiOperation({ summary: 'Preview báo cáo hàng bán theo khách' })
  getProductByCustomerPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getProductByCustomerPreview(query);
  }

  @Get('product-by-customer/chart')
  @ReportPermission({ key: 'reports:customer_product' })
  @ApiOperation({ summary: 'Biểu đồ hàng bán theo khách (top 20)' })
  getProductByCustomerChart(@Query() query: ReportQueryDto) {
    return this.reportsService.getProductByCustomerChart(query);
  }

  // ── Báo cáo 2: Export Excel ──
  @Get('product-by-customer/export')
  @ReportPermission({
    key: 'reports:customer_product',
    exportKey: 'reports:export_customer',
  })
  @ApiOperation({ summary: 'Xuất Excel hàng bán theo khách' })
  async exportProductByCustomer(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `hang-ban-theo-khach_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportProductByCustomer(query, res);
  }

  // ── Báo cáo 3: Preview ──
  @Get('customer-debt')
  @ReportPermission({ key: 'reports:customer_debt' })
  @ApiOperation({ summary: 'Preview báo cáo công nợ theo khách hàng' })
  getCustomerDebtPreview(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerDebtPreview(query);
  }

  @Get('customer-debt/chart')
  @ReportPermission({ key: 'reports:customer_debt' })
  @ApiOperation({ summary: 'Biểu đồ công nợ theo khách (top 20)' })
  getCustomerDebtChart(@Query() query: ReportQueryDto) {
    return this.reportsService.getCustomerDebtChart(query);
  }

  // ── Báo cáo 3: Export Excel ──
  @Get('customer-debt/export')
  @ReportPermission({
    key: 'reports:customer_debt',
    exportKey: 'reports:export_customer',
  })
  @ApiOperation({ summary: 'Xuất Excel báo cáo công nợ theo khách hàng' })
  async exportCustomerDebt(
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ) {
    const filename = `bao-cao-cong-no-theo-khach-hang_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await this.reportsService.exportCustomerDebt(query, res);
  }
}
