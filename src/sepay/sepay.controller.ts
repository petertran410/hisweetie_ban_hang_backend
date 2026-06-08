import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
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
import { AssignCustomerDto, ConfirmReceiptDto } from './dto/sepay-match.dto';

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
  async getTransactions(@Query() query: SepayTransactionQueryDto) {
    return this.sepaySyncService.findAll(query);
  }

  /**
   * Sale gán khách hàng cho 1 giao dịch (chưa tạo phiếu thu).
   */
  @Put('transactions/:id/assign')
  @RequirePermissions('sepay:assign')
  @ApiOperation({ summary: 'Gán khách hàng cho giao dịch Sepay' })
  async assignCustomer(
    @Param('id') id: string,
    @Body() dto: AssignCustomerDto,
    @CurrentUser() user: any,
  ) {
    return this.sepayMatchService.assignCustomer(
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
}
