import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicApiAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async issueToken(input: {
    grantType?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  }) {
    if (input.grantType !== 'client_credentials') {
      throw new BadRequestException({
        error: 'unsupported_grant_type',
        error_description: 'Only client_credentials is supported',
      });
    }
    if (!input.clientId || !input.clientSecret) {
      throw new UnauthorizedException({
        error: 'invalid_client',
        error_description: 'client_id and client_secret are required',
      });
    }

    const client = await this.prisma.publicApiClient.findUnique({
      where: { clientId: input.clientId },
    });
    if (!client || !client.isActive || !(await bcrypt.compare(input.clientSecret, client.clientSecret))) {
      throw new UnauthorizedException({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    }

    const expiresIn = Math.max(300, Math.min(client.accessTokenTtl, 86400));
    const accessToken = await this.jwtService.signAsync(
      { sub: client.id, clientId: client.clientId, typ: 'public_api' },
      { secret: this.getTokenSecret(), expiresIn },
    );

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: input.scope || 'public_api.read',
    };
  }

  private getTokenSecret(): string {
    const secret = process.env.PUBLIC_API_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('PUBLIC_API_JWT_SECRET or JWT_SECRET must be configured');
    return secret;
  }
}
