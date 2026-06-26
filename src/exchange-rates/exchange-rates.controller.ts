import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ExchangeRatesService } from './exchange-rates.service';
import {
  GetExchangeRateDto,
  RefreshExchangeRateDto,
} from './dto/exchange-rate.dto';

/**
 * Endpoint cung cấp tỉ giá ngoại tệ cho hệ thống.
 *
 * - `GET  /api/exchange-rates/latest?base=CNY&symbols=VND` — lấy tỉ giá (cache 15p).
 * - `POST /api/exchange-rates/refresh?base=CNY&symbols=VND` — ép refresh, bỏ qua cache.
 *
 * Auth: yêu cầu JWT (bất kỳ user đăng nhập nào cũng dùng được, vì tỉ giá là
 * thông tin tham khảo, không phân quyền theo role).
 */
@ApiTags('Exchange Rates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly service: ExchangeRatesService) {}

  @Get('latest')
  async getLatest(@Query() query: GetExchangeRateDto) {
    const base = (query.base || 'CNY').toUpperCase();
    const target = (query.symbols || 'VND').toUpperCase();
    if (base === target) {
      throw new BadRequestException(
        'base và symbols phải khác nhau (không quy đổi đồng tiền giống nhau)',
      );
    }
    return this.service.getLatestRate(base, target);
  }

  @Post('refresh')
  async refresh(@Query() query: RefreshExchangeRateDto) {
    const base = (query.base || 'CNY').toUpperCase();
    const target = (query.symbols || 'VND').toUpperCase();
    if (base === target) {
      throw new BadRequestException(
        'base và symbols phải khác nhau (không quy đổi đồng tiền giống nhau)',
      );
    }
    return this.service.refreshRate(base, target);
  }
}
