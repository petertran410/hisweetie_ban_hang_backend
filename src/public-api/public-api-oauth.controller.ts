import { Body, Controller, Headers, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PublicApiAuthService } from './public-api-auth.service';

@Controller('public/v1/oauth')
export class PublicApiOAuthController {
  constructor(private readonly authService: PublicApiAuthService) {}

  @Public()
  @Post('token')
  issueToken(
    @Headers('content-type') contentType: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    // The global JSON parser is already enabled. Accept JSON and form-style
    // payloads so integrations can follow standard OAuth client libraries.
    void contentType;
    return this.authService.issueToken({
      grantType: String(body.grant_type || ''),
      clientId: String(body.client_id || ''),
      clientSecret: String(body.client_secret || ''),
      scope: body.scope ? String(body.scope) : undefined,
    });
  }
}
