import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface PublicApiTokenPayload {
  sub: string;
  clientId: string;
  typ: 'public_api';
}

/**
 * Chỉ dùng cục bộ trong PublicApiController qua @UseGuards, nên mọi request đi
 * tới đây đều là Public API — không cần đọc metadata để phân biệt.
 */
@Injectable()
export class PublicApiAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing public API bearer token');
    }

    const token = authorization.slice('Bearer '.length).trim();
    let payload: PublicApiTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<PublicApiTokenPayload>(
        token,
        {
          secret: this.getTokenSecret(),
        },
      );
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired public API bearer token',
      );
    }

    if (payload.typ !== 'public_api' || !payload.sub || !payload.clientId) {
      throw new UnauthorizedException('Invalid public API bearer token');
    }

    // Token đã ký vẫn sống tới hết hạn, nên phải soi trạng thái client ở mỗi
    // request: có vậy thao tác tắt client trong POS mới chặn được ngay các
    // token đã phát trước đó.
    const client = await this.prisma.publicApiClient.findUnique({
      where: { id: payload.sub },
      select: { id: true, isActive: true },
    });
    if (!client?.isActive) {
      throw new UnauthorizedException('Public API client is inactive');
    }

    request.publicApiClient = { id: payload.sub, clientId: payload.clientId };
    return true;
  }

  private getTokenSecret(): string {
    const secret = process.env.PUBLIC_API_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('PUBLIC_API_JWT_SECRET or JWT_SECRET must be configured');
    }
    return secret;
  }
}
