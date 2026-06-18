import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { RequireAnyPermission } from '../auth/decorators/permissions.decorator';
import { MisaCallbackRequestDto } from './dto';
import { MisaBulkVoucherRequestDto, MisaCreateVoucherRequestDto } from './dto';
import { MisaDictionaryService } from './misa-dictionary.service';
import { MisaVoucherService } from './misa-voucher.service';

@ApiTags('Misa Sync')
@ApiBearerAuth()
@Controller('misa')
export class MisaSyncController {
  private readonly logger = new Logger(MisaSyncController.name);

  constructor(
    private readonly misaVoucherService: MisaVoucherService,
    private readonly misaDictionaryService: MisaDictionaryService,
  ) {}

  @Get('employees')
  @RequireAnyPermission('vat_invoices:view', 'customers:link_misa')
  @ApiOperation({
    summary: 'Danh sách nhân viên phụ trách (Misa, isEmployee = true)',
  })
  async getEmployees(): Promise<{ id: string; code: string; name: string }[]> {
    return this.misaDictionaryService.findEmployees();
  }

  @Get('inventory-items')
  @RequirePermissions('products:link_misa')
  @ApiOperation({
    summary: 'Tìm kiếm vật tư hàng hóa Misa để liên kết với sản phẩm',
  })
  async getInventoryItems(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ): Promise<
    { id: string; code: string; name: string; unitName: string | null }[]
  > {
    return this.misaDictionaryService.findInventoryItems(
      search,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('dictionary/sync')
  @RequirePermissions('vat_invoices:push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sync danh mục Misa về database' })
  async syncAllDictionaries(): Promise<{
    success: boolean;
    message: string;
    data?: {
      inventoryItems: number;
      stocks: number;
      accountObjects: number;
      organizationUnits: number;
    };
  }> {
    this.logger.log('📦 Manual Misa dictionary sync triggered');

    try {
      const result = await this.misaDictionaryService.syncAllDictionaries();
      return {
        success: true,
        message: 'Dictionary sync completed',
        data: result,
      };
    } catch (error) {
      this.logger.error(`❌ Dictionary sync failed: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  @Post('voucher/create/:invoiceCode')
  @RequirePermissions('vat_invoices:push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tạo chứng từ bán hàng Misa từ mã hóa đơn' })
  async createVoucherFromInvoice(
    @Param('invoiceCode') invoiceCode: string,
    @Body() body?: MisaCreateVoucherRequestDto,
  ): Promise<{
    success: boolean;
    orgRefId: string | null;
    message: string;
  }> {
    this.logger.log(
      `🧾 Manual create Misa voucher for invoice code: ${invoiceCode}`,
    );

    try {
      return await this.misaVoucherService.createSaleVoucherFromInvoice(
        invoiceCode,
        body?.buyerOverride,
        body?.force,
      );
    } catch (error) {
      this.logger.error(
        `❌ Create voucher failed for invoice ${invoiceCode}: ${error.message}`,
      );
      return {
        success: false,
        orgRefId: null,
        message: error.message,
      };
    }
  }

  @Post('voucher/bulk-create')
  @RequirePermissions('vat_invoices:push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đẩy hàng loạt hóa đơn lên Misa theo danh sách mã' })
  async createVouchersBulk(@Body() body: MisaBulkVoucherRequestDto): Promise<{
    success: boolean;
    message: string;
    total: number;
    successCount: number;
    failedCount: number;
    results: Array<{
      invoiceCode: string;
      success: boolean;
      orgRefId: string | null;
      message: string;
    }>;
  }> {
    this.logger.log(
      `📦 Manual bulk create Misa vouchers for ${body.invoiceCodes.length} invoices`,
    );

    return this.misaVoucherService.createVouchersBulk(
      body.invoiceCodes,
      body.buyerOverrides,
      body.force,
    );
  }

  @Post('voucher/retry')
  @RequirePermissions('vat_invoices:push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry các hóa đơn đẩy Misa bị FAILED' })
  async retryFailedVouchers(): Promise<{
    success: boolean;
    message: string;
    retriedCount?: number;
  }> {
    this.logger.log('🔄 Retry failed Misa vouchers triggered');

    try {
      const successCount =
        await this.misaVoucherService.retryFailedInvoices(10);
      return {
        success: true,
        message: 'Retried failed invoices',
        retriedCount: successCount,
      };
    } catch (error) {
      this.logger.error(`❌ Retry failed: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  @Post('voucher/delete/:invoiceCode')
  @RequirePermissions('vat_invoices:delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Xóa đề nghị sinh chứng từ Misa theo mã hóa đơn' })
  async deleteVoucherByInvoiceCode(
    @Param('invoiceCode') invoiceCode: string,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    this.logger.log(`🗑️ Delete Misa voucher for invoice code: ${invoiceCode}`);

    try {
      return await this.misaVoucherService.deleteVoucherByInvoiceCode(
        invoiceCode,
      );
    } catch (error) {
      this.logger.error(
        `❌ Delete voucher failed for invoice ${invoiceCode}: ${error.message}`,
      );
      return {
        success: false,
        message: error.message,
      };
    }
  }

  @Public()
  @Post('callback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Callback Misa sau khi xử lý chứng từ' })
  async handleCallback(
    @Body() body: MisaCallbackRequestDto,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`📩 Received Misa callback: ${JSON.stringify(body)}`);

    try {
      if (!body.data || !Array.isArray(body.data)) {
        this.logger.warn('⚠️ Invalid callback data format');
        return {
          success: false,
          message: 'Invalid data format',
        };
      }

      for (const item of body.data) {
        await this.misaVoucherService.handleMisaCallback(
          item.org_refid,
          item.status,
          item.voucher_id,
          item.voucher_no,
          item.error_code,
          item.error_message,
        );
      }

      return {
        success: true,
        message: `Processed ${body.data.length} callback(s)`,
      };
    } catch (error) {
      this.logger.error(`❌ Error processing Misa callback: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  @Public()
  @Get('health')
  @HttpCode(200)
  @ApiOperation({ summary: 'Misa callback health check' })
  healthCheck(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
