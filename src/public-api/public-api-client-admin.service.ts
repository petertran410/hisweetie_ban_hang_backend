import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePublicApiClientDto,
  UpdatePublicApiClientDto,
} from './dto/manage-public-api-client.dto';

/** Chỉ trả các trường an toàn; `clientSecret` (hash) không bao giờ rời khỏi server. */
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  description: true,
  clientId: true,
  isActive: true,
  accessTokenTtl: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class PublicApiClientAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const [clients, webhookGroups] = await Promise.all([
      this.prisma.publicApiClient.findMany({
        select: PUBLIC_FIELDS,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.publicApiWebhook.groupBy({
        by: ['clientId'],
        _count: { _all: true },
      }),
    ]);

    const webhookCounts = new Map(
      webhookGroups.map((group) => [group.clientId, group._count._all]),
    );

    return {
      total: clients.length,
      data: clients.map((client) => ({
        ...client,
        webhookCount: webhookCounts.get(client.id) ?? 0,
      })),
    };
  }

  /**
   * Tạo client mới.
   *
   * Secret thô chỉ tồn tại trong response này; cơ sở dữ liệu chỉ lưu bcrypt hash
   * nên không ai — kể cả quản trị viên — xem lại được. Mất thì phải cấp lại.
   */
  async create(dto: CreatePublicApiClientDto) {
    const clientSecret = randomBytes(32).toString('base64url');
    const client = await this.prisma.publicApiClient.create({
      data: {
        name: dto.name,
        description: dto.description,
        clientId: `hpa_${randomUUID().replace(/-/g, '')}`,
        clientSecret: await bcrypt.hash(clientSecret, 10),
        accessTokenTtl: dto.accessTokenTtl ?? 3600,
      },
      select: PUBLIC_FIELDS,
    });
    return { data: { ...client, clientSecret } };
  }

  async update(id: string, dto: UpdatePublicApiClientDto) {
    await this.assertExists(id);
    const client = await this.prisma.publicApiClient.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        accessTokenTtl: dto.accessTokenTtl,
      },
      select: PUBLIC_FIELDS,
    });
    return { data: client };
  }

  /** Cấp secret mới; secret cũ mất hiệu lực ngay khi bản ghi được ghi đè. */
  async rotateSecret(id: string) {
    await this.assertExists(id);
    const clientSecret = randomBytes(32).toString('base64url');
    const client = await this.prisma.publicApiClient.update({
      where: { id },
      data: { clientSecret: await bcrypt.hash(clientSecret, 10) },
      select: PUBLIC_FIELDS,
    });
    return { data: { ...client, clientSecret } };
  }

  /**
   * Bật/tắt client. Không có xoá: client gắn với nhật ký gọi API, đăng ký
   * webhook và khoá idempotency — xoá đi là mất dấu vết đối soát.
   */
  async setActive(id: string, isActive: boolean) {
    await this.assertExists(id);
    const client = await this.prisma.publicApiClient.update({
      where: { id },
      data: { isActive },
      select: PUBLIC_FIELDS,
    });
    return { data: client };
  }

  private async assertExists(id: string) {
    const client = await this.prisma.publicApiClient.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Không tìm thấy OAuth client');
  }
}
