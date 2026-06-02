import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  MisaConnectRequestDto,
  MisaConnectResponseDto,
  MisaCachedTokenDto,
  MisaTokenDataDto,
} from './dto';

@Injectable()
export class MisaAuthService {
  private readonly logger = new Logger(MisaAuthService.name);
  private cachedToken: MisaCachedTokenDto | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Lấy access token từ Misa API
   * Token được cache 12h, tự động refresh khi gần hết hạn
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!.accessToken;
    }

    return this.refreshToken();
  }

  /**
   * Kiểm tra token hiện tại còn hạn không
   */
  private isTokenValid(): boolean {
    if (!this.cachedToken) {
      return false;
    }

    const now = new Date();
    const bufferMs = 30 * 60 * 1000; // 30 phút buffer
    const expiresAt = new Date(this.cachedToken.expiresAt.getTime() - bufferMs);

    return now < expiresAt;
  }

  /**
   * Gọi API để lấy token mới
   */
  private async refreshToken(): Promise<string> {
    const baseUrl = this.configService.get<string>('MISA_BASE_URL');
    const appId = this.configService.get<string>('MISA_APP_ID');
    const accessCode = this.configService.get<string>('MISA_ACCESS_CODE');
    const orgCompanyCode = this.configService.get<string>(
      'MISA_ORG_COMPANY_CODE',
    );

    const url = `${baseUrl}/api/oauth/actopen/connect`;

    const requestBody: MisaConnectRequestDto = {
      app_id: appId || '',
      access_code: accessCode || '',
      org_company_code: orgCompanyCode || '',
    };

    this.logger.log('🔐 Requesting new Misa access token...');
    this.logger.debug(`Request URL: ${url}`);

    try {
      const response = await firstValueFrom(
        this.httpService.post<MisaConnectResponseDto>(url, requestBody, {
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );

      const data = response.data;

      this.logger.debug(`Raw response: ${JSON.stringify(data)}`);

      if (!data.Success) {
        const errorMsg = `Misa connect failed: ${data.ErrorCode} - ${data.ErrorMessage}`;
        this.logger.error(`❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Xử lý Data có thể là string JSON hoặc object
      let tokenData: MisaTokenDataDto | undefined = data.Data as
        | MisaTokenDataDto
        | undefined;

      if (typeof data.Data === 'string') {
        try {
          tokenData = JSON.parse(data.Data) as MisaTokenDataDto;
          this.logger.debug(
            `Parsed Data from string: ${JSON.stringify(tokenData)}`,
          );
        } catch (parseError) {
          this.logger.error(`❌ Failed to parse Data as JSON: ${data.Data}`);
          throw new Error('Misa connect response Data is not valid JSON');
        }
      }

      if (!tokenData?.access_token) {
        this.logger.error(
          `❌ Token data structure: ${JSON.stringify(tokenData)}`,
        );
        throw new Error('Misa connect response missing access_token');
      }

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 12);

      this.cachedToken = {
        accessToken: tokenData.access_token,
        expiresAt: expiresAt,
      };

      this.logger.log(
        `✅ Misa access token obtained, expires at: ${expiresAt.toISOString()}`,
      );

      return this.cachedToken.accessToken;
    } catch (error) {
      if (error.response) {
        this.logger.error(
          `❌ Misa API error response: ${JSON.stringify(error.response.data)}`,
        );
      }
      this.logger.error(`❌ Failed to get Misa access token: ${error.message}`);
      throw error;
    }
  }

  /**
   * Force refresh token (dùng khi cần)
   */
  async forceRefreshToken(): Promise<string> {
    this.cachedToken = null;
    return this.refreshToken();
  }

  /**
   * Xóa cached token
   */
  clearToken(): void {
    this.cachedToken = null;
    this.logger.log('🗑️ Misa cached token cleared');
  }

  /**
   * Lấy thông tin token hiện tại (for debugging)
   */
  getTokenInfo(): { hasToken: boolean; expiresAt: Date | null } {
    return {
      hasToken: !!this.cachedToken,
      expiresAt: this.cachedToken?.expiresAt || null,
    };
  }
}
