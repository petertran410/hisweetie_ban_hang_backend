import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
  RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { SepayService } from './sepay.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';

@ApiTags('Sepay')
@Controller('sepay')
export class SepayController {
  constructor(
    private sepayService: SepayService,
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
}
