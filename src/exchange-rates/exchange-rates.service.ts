import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Thông tin tỉ giá trả về cho client. Kèm `fetchedAt` + cờ `isStale` để
 * frontend quyết định có nên hiển thị badge "cập nhật lúc ..." hay không.
 */
export interface ExchangeRateInfo {
  base: string;
  target: string;
  rate: number;
  fetchedAt: Date;
  isStale: boolean;
}

/**
 * URL gốc của fxratesapi.com. Có thể override qua env `FX_RATES_API_URL`
 * (vd khi dev muốn trỏ sang mock server).
 *
 * Endpoint: `/latest?base=CNY&symbols=VND` → trả JSON:
 *   {
 *     "base": "CNY",
 *     "date": "2024-06-10",
 *     "rates": { "VND": 3500.12 }
 *   }
 *
 * Lưu ý: free tier giới hạn ~100 req/tháng, không cần API key.
 */
const DEFAULT_FX_API_URL = 'https://api.fxratesapi.com/latest';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 phút theo yêu cầu
const REQUEST_TIMEOUT_MS = 5_000;

interface FxApiResponse {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

@Injectable()
export class ExchangeRatesService {
  private readonly logger = new Logger(ExchangeRatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Lấy tỉ giá mới nhất cho cặp (base, target).
   *
   * Hành vi:
   *   1. Nếu có cache trong DB và `fetchedAt` < TTL → trả cache, `isStale=false`.
   *   2. Nếu cache tồn tại nhưng đã stale (>15p) → trả cache cũ ngay cho client
   *      không phải chờ, đồng thời fire-and-forget refresh() để cập nhật cache
   *      cho lần gọi sau.
   *   3. Nếu không có cache → gọi API bên ngoài, lưu cache, trả về.
   *
   * @throws ServiceUnavailableException khi không có cache và API ngoài lỗi.
   */
  async getLatestRate(base: string, target: string): Promise<ExchangeRateInfo> {
    const cached = await this.prisma.exchangeRate.findUnique({
      where: { base_target: { base, target } },
    });

    if (cached) {
      const ageMs = Date.now() - cached.fetchedAt.getTime();
      if (ageMs < CACHE_TTL_MS) {
        return {
          base: cached.base,
          target: cached.target,
          rate: Number(cached.rate),
          fetchedAt: cached.fetchedAt,
          isStale: false,
        };
      }
      // Stale: trả cache ngay, refresh ngầm.
      void this.refreshFromExternal(base, target).catch((err) =>
        this.logger.warn(
          `Background refresh ${base}->${target} lỗi: ${(err as Error).message}`,
        ),
      );
      return {
        base: cached.base,
        target: cached.target,
        rate: Number(cached.rate),
        fetchedAt: cached.fetchedAt,
        isStale: true,
      };
    }

    // Cache miss: phải gọi API đồng bộ.
    const fetched = await this.refreshFromExternal(base, target);
    return {
      base,
      target,
      rate: Number(fetched.rate),
      fetchedAt: fetched.fetchedAt,
      isStale: false,
    };
  }

  /**
   * Lấy tỉ giá nhiều target cùng lúc (1 lần gọi API, parse nhiều rates).
   * Dùng cho trường hợp sau này mở rộng nhiều loại ngoại tệ.
   */
  async getLatestRates(
    base: string,
    targets: string[],
  ): Promise<ExchangeRateInfo[]> {
    const results: ExchangeRateInfo[] = [];
    for (const target of targets) {
      results.push(await this.getLatestRate(base, target));
    }
    return results;
  }

  /**
   * Bypass cache, ép gọi API ngoài và cập nhật DB.
   * Dùng khi user ấn nút "Cập nhật tỉ giá" trên form.
   */
  async refreshRate(base: string, target: string): Promise<ExchangeRateInfo> {
    const fetched = await this.refreshFromExternal(base, target);
    return {
      base,
      target,
      rate: Number(fetched.rate),
      fetchedAt: fetched.fetchedAt,
      isStale: false,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // CRON
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Cron 15 phút 1 lần: tự động refresh các cặp tỉ giá phổ biến.
   * Hiện tại chỉ refresh CNY→VND (use case chính). Có thể mở rộng.
   */
  @Cron('*/15 * * * *')
  async handleCronRefresh() {
    const pairs: Array<[string, string]> = [['CNY', 'VND']];
    for (const [base, target] of pairs) {
      try {
        await this.refreshFromExternal(base, target);
        this.logger.log(`Cron refresh ${base}->${target} OK`);
      } catch (err) {
        this.logger.warn(
          `Cron refresh ${base}->${target} lỗi: ${(err as Error).message}`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // INTERNAL
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Gọi fxratesapi.com, parse response, upsert vào DB.
   * Trả về row DB mới nhất.
   */
  private async refreshFromExternal(base: string, target: string) {
    const apiUrl = this.config.get<string>(
      'FX_RATES_API_URL',
      DEFAULT_FX_API_URL,
    );
    const url = `${apiUrl}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(target)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      clearTimeout(timeout);
      const message =
        (err as Error).name === 'AbortError'
          ? `Timeout sau ${REQUEST_TIMEOUT_MS}ms`
          : (err as Error).message;
      throw new ServiceUnavailableException(
        `Không gọi được API tỉ giá (${base}->${target}): ${message}`,
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      throw new ServiceUnavailableException(
        `API tỉ giá trả ${response.status}: ${response.statusText}`,
      );
    }

    const json = (await response.json()) as FxApiResponse;
    const rate = json.rates?.[target];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new ServiceUnavailableException(
        `API tỉ giá không trả về rate hợp lệ cho ${base}->${target}`,
      );
    }

    const fetchedAt = new Date();
    await this.prisma.exchangeRate.upsert({
      where: { base_target: { base, target } },
      create: { base, target, rate, fetchedAt },
      update: { rate, fetchedAt },
    });

    return {
      base,
      target,
      rate,
      fetchedAt,
    };
  }
}
