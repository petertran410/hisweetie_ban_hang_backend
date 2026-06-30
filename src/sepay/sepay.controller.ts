import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  Req,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
  RawBodyRequest,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SepayService } from './sepay.service';
import { SepaySyncService } from './sepay-sync.service';
import { SepayMatchService } from './sepay-match.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';
import { SepayTransactionQueryDto } from './dto/sepay-transaction-query.dto';
import { AssignCustomersDto, ConfirmReceiptDto } from './dto/sepay-match.dto';
import { SepayBackfillDto } from './dto/sepay-backfill.dto';
import { SepayBackfillCashflowDto } from './dto/sepay-backfill-cashflow.dto';

@ApiTags('Sepay')
@Controller('sepay')
export class SepayController {
  private readonly logger = new Logger(SepayController.name);

  constructor(
    private sepayService: SepayService,
    private sepaySyncService: SepaySyncService,
    private sepayMatchService: SepayMatchService,
    private configService: ConfigService,
  ) {}

  @Public()
  @Post('webhook')
  @ApiOperation({ summary: 'Sepay webhook — HMAC-SHA256 verified' })
  async handleWebhook(
    @Headers('x-sepay-signature') signatureHeader: string,
    @Headers('x-sepay-timestamp') timestampHeader: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: SepayWebhookDto,
  ) {
    const secret = this.configService.get<string>('SEPAY_WEBHOOK_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'SEPAY_WEBHOOK_SECRET chưa được cấu hình',
      );
    }

    if (!signatureHeader || !timestampHeader) {
      throw new UnauthorizedException(
        'Missing X-SePay-Signature / X-SePay-Timestamp header',
      );
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Missing raw body');
    }

    // Chống replay: timestamp (Unix giây) lệch quá ±5 phút thì loại
    const timestamp = Number(timestampHeader);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300
    ) {
      throw new UnauthorizedException('Request expired');
    }

    // Sepay ký `{timestamp}.{raw_body}` — update 2 bước để giữ byte gốc
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${timestampHeader}.`);
    hmac.update(rawBody);
    const expectedHex = hmac.digest('hex');

    // Header dạng "sha256={hex}" — bỏ tiền tố
    const receivedHex = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice(7)
      : signatureHeader;

    let valid = false;
    try {
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const receivedBuf = Buffer.from(receivedHex, 'hex');
      valid =
        expectedBuf.length === receivedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    return this.sepayService.handleWebhook(payload);
  }

  /**
   * Nhận tin nhắn SMS ngân hàng từ MacroDroid gửi thẳng vào backend.
   * Auth bằng shared secret (X-External-Secret header) thay vì HMAC vì
   * MacroDroid không hỗ trợ ký HMAC.
   *
   * Body là object đầy đủ chứa field `body_message` (đoạn SMS ngân hàng).
   * Idempotent: cùng body_message → upsert (không trùng record).
   */
  @Public()
  @Post('external-message')
  @ApiOperation({
    summary: 'Nhận tin nhắn ngân hàng từ MacroDroid (SMS forwarding)',
  })
  async handleExternalMessage(
    @Headers('x-external-secret') secretHeader: string,
    @Query('X-External-Secret') secretQueryUpper: string,
    @Query('secret') secretQueryLower: string,
    @Body() body: any,
  ) {
    const secret = this.configService.get<string>('SEPAY_EXTERNAL_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'SEPAY_EXTERNAL_SECRET chưa được cấu hình',
      );
    }

    // Chấp nhận secret ở header (khuyến nghị) hoặc query (tương thích cấu hình
    // MacroDroid hiện tại). Query bị ghi vào log → nên ưu tiên dùng header.
    const received = secretHeader || secretQueryUpper || secretQueryLower || '';

    if (!received) {
      throw new UnauthorizedException(
        'Missing X-External-Secret (header hoặc query)',
      );
    }

    // timingSafeEqual chống timing attack
    let valid = false;
    try {
      const expectedBuf = Buffer.from(secret);
      const receivedBuf = Buffer.from(received);
      valid =
        expectedBuf.length === receivedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedException('Invalid secret');
    }

    return this.sepayService.handleExternalMessage(body);
  }

  /**
   * Đồng bộ toàn bộ lịch sử giao dịch Sepay vào bảng sepay_transactions.
   * KHÔNG tạo phiếu thu / KHÔNG đụng đơn / hóa đơn / sổ quỹ — chỉ lưu lịch sử thô.
   * Idempotent: chạy lại nhiều lần không tạo trùng (upsert theo sepayId).
   */
  @Post('sync')
  @RequirePermissions('sepay:sync')
  @ApiOperation({ summary: 'Đồng bộ lịch sử giao dịch Sepay (lưu bảng riêng)' })
  async syncTransactions() {
    this.logger.log('📨 Manual Sepay transactions sync triggered');
    const result = await this.sepaySyncService.syncAll();
    return {
      success: true,
      result,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Danh sách giao dịch Sepay đã đồng bộ (đọc bảng sepay_transactions).
   * Filter đầy đủ + phân trang. Chỉ đọc, không gọi Sepay API.
   */
  @Get('transactions')
  @RequirePermissions('sepay:view')
  @ApiOperation({ summary: 'Danh sách biến động số dư (giao dịch Sepay)' })
  async getTransactions(
    @Query() query: SepayTransactionQueryDto,
    @CurrentUser() user: any,
    @Headers('x-branch-id') branchIdHeader?: string,
  ) {
    const branchId = branchIdHeader ? parseInt(branchIdHeader, 10) : undefined;
    return this.sepaySyncService.findAll(
      query,
      user,
      branchId && !isNaN(branchId) ? branchId : undefined,
    );
  }

  /**
   * Tổng hợp giao dịch cần xử lý (cho thông báo sale). Tôn trọng lọc theo TK.
   */
  @Get('transactions/pending')
  @RequirePermissions('sepay:view')
  @ApiOperation({ summary: 'Đếm giao dịch Sepay cần xử lý (thông báo)' })
  async getPendingSummary(
    @CurrentUser() user: any,
    @Headers('x-branch-id') branchIdHeader?: string,
  ) {
    const branchId = branchIdHeader ? parseInt(branchIdHeader, 10) : undefined;
    return this.sepaySyncService.getPendingSummary(
      user,
      branchId && !isNaN(branchId) ? branchId : undefined,
    );
  }

  /**
   * Sale gán khách hàng cho 1 giao dịch (chưa tạo phiếu thu).
   */
  @Put('transactions/:id/assign')
  @RequirePermissions('sepay:assign')
  @ApiOperation({ summary: 'Gán (nhiều) khách hàng cho giao dịch Sepay' })
  async assignCustomer(
    @Param('id') id: string,
    @Body() dto: AssignCustomersDto,
    @CurrentUser() user: any,
  ) {
    return this.sepayMatchService.assignCustomers(
      Number(id),
      dto,
      user?.id || 1,
    );
  }

  /**
   * Bỏ gán khách hàng (chỉ khi chưa tạo phiếu thu).
   */
  @Delete('transactions/:id/assign')
  @RequirePermissions('sepay:assign')
  @ApiOperation({ summary: 'Bỏ gán khách hàng cho giao dịch Sepay' })
  async unassignCustomer(@Param('id') id: string) {
    return this.sepayMatchService.unassignCustomer(Number(id));
  }

  /**
   * Kế toán xác nhận & tạo phiếu thu trừ công nợ từ giao dịch.
   */
  @Post('transactions/:id/confirm')
  @RequirePermissions('sepay:confirm')
  @ApiOperation({ summary: 'Xác nhận & tạo phiếu thu từ giao dịch Sepay' })
  async confirmReceipt(
    @Param('id') id: string,
    @Body() dto: ConfirmReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.sepayMatchService.confirmReceipt(
      Number(id),
      dto,
      user?.id || 1,
    );
  }

  /**
   * Ẩn 1 giao dịch khỏi danh sách (ẩn chung toàn hệ thống).
   */
  @Patch('transactions/:id/hide')
  @RequirePermissions('sepay:assign')
  @ApiOperation({ summary: 'Ẩn giao dịch Sepay khỏi danh sách' })
  async hideTransaction(@Param('id') id: string, @CurrentUser() user: any) {
    return this.sepaySyncService.hideTransaction(Number(id), user?.id);
  }

  /**
   * Bỏ ẩn 1 giao dịch — hiển thị lại trong danh sách.
   */
  @Patch('transactions/:id/unhide')
  @RequirePermissions('sepay:assign')
  @ApiOperation({ summary: 'Bỏ ẩn giao dịch Sepay' })
  async unhideTransaction(@Param('id') id: string) {
    return this.sepaySyncService.unhideTransaction(Number(id));
  }

  /**
   * Backfill transactionContent cho các sepay_transactions thuộc TK đặc biệt
   * (env SEPAY_SPECIAL_ACCOUNT_NUMBERS). Lấy lại content gốc từ rawPayload
   * và cập nhật transactionContent. KHÔNG đụng CashFlow.description.
   * Idempotent — chạy lại nhiều lần không thay đổi record đã đúng.
   */
  @Post('backfill-content')
  @RequirePermissions('sepay:sync')
  @ApiOperation({
    summary: 'Backfill transactionContent cho TK Sepay đặc biệt',
  })
  async backfillContent(
    @Body() dto: SepayBackfillDto,
    @CurrentUser() user: any,
  ) {
    this.logger.log(
      `📨 Manual Sepay backfill-content triggered by user=${user?.id ?? 'system'}`,
    );
    const result = await this.sepaySyncService.backfillSpecialAccountContent(
      dto.limit ?? 1000,
      user?.id,
    );
    return {
      success: true,
      result,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Preview backfill CashFlow.description cho các phiếu thu liên quan Sepay.
   * KHÔNG ghi DB. Trả về danh sách đầy đủ các phiếu thu sẽ bị sửa + nội dung mới.
   *
   * Áp dụng cho:
   *   - Phiếu thu từ webhook (InvoicePayment/OrderPayment có sepayTransactionId)
   *   - Phiếu thu từ biến động số dư (qua SepayAllocation)
   * BỎ QUA phiếu thu thủ công từ trang KH/sổ quỹ.
   *
   * Nội dung mới:
   *   - TK đặc biệt (env) → transactionContent
   *   - Ngân hàng khác → referenceNumber
   */
  @Post('backfill-cashflow-description-preview')
  @RequirePermissions('sepay:sync')
  @ApiOperation({
    summary: 'Preview backfill CashFlow.description (KHÔNG ghi DB)',
  })
  async previewCashflowDescription(@Body() dto: SepayBackfillCashflowDto) {
    this.logger.log(
      `🔍 Sepay backfill-cashflow-description-preview triggered (limit=${dto.limit ?? 1000})`,
    );
    const result = await this.sepaySyncService.previewCashflowDescription(
      dto.limit ?? 1000,
    );
    return {
      success: true,
      result,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Apply backfill CashFlow.description cho các phiếu thu liên quan Sepay.
   * GHI DB. Idempotent — chạy lại nhiều lần không thay đổi record đã đúng.
   *
   * Nên chạy preview trước để kiểm tra danh sách sẽ bị sửa.
   */
  @Post('backfill-cashflow-description')
  @RequirePermissions('sepay:sync')
  @ApiOperation({
    summary: 'Apply backfill CashFlow.description (GHI DB)',
  })
  async backfillCashflowDescription(
    @Body() dto: SepayBackfillCashflowDto,
    @CurrentUser() user: any,
  ) {
    this.logger.log(
      `📨 Sepay backfill-cashflow-description triggered by user=${user?.id ?? 'system'} (limit=${dto.limit ?? 1000})`,
    );
    const result = await this.sepaySyncService.backfillCashflowDescription(
      dto.limit ?? 1000,
      user?.id,
    );
    return {
      success: true,
      result,
      timestamp: new Date().toISOString(),
    };
  }
}
