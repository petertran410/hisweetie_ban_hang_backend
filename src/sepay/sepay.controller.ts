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
    @Headers('x-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: SepayWebhookDto,
  ) {
    const secret = this.configService.get<string>('SEPAY_WEBHOOK_SECRET');
    if (!secret) {
      throw new InternalServerErrorException(
        'SEPAY_WEBHOOK_SECRET chưa được cấu hình',
      );
    }

    if (!signature) {
      throw new UnauthorizedException('Missing X-Signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Missing raw body');
    }

    // Tính HMAC-SHA256 của raw body bằng secret
    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    // So sánh đẳng thời gian (chống timing attack).
    // Bắt buộc: 2 buffer phải cùng độ dài, không thì timingSafeEqual throw.
    let valid = false;
    try {
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const receivedBuf = Buffer.from(signature, 'hex');
      if (expectedBuf.length === receivedBuf.length) {
        valid = crypto.timingSafeEqual(expectedBuf, receivedBuf);
      }
    } catch {
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    return this.sepayService.handleWebhook(payload);
  }
}
