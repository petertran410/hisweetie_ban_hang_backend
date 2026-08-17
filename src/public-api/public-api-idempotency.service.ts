import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** Khoá quá hạn sẽ được dọn; sau mốc này cùng một khoá được coi là request mới. */
const RETENTION_HOURS = 24;

interface RunOptions {
  clientId: string;
  key?: string;
  method: string;
  path: string;
  body: unknown;
}

@Injectable()
export class PublicApiIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Chạy `operation` đúng một lần cho mỗi `Idempotency-Key`.
   *
   * Không có khoá thì chạy thẳng — client tự chịu rủi ro trùng. Có khoá thì:
   *  - Lần đầu: ghi bản ghi PROCESSING rồi chạy nghiệp vụ, xong lưu phản hồi.
   *  - Gọi lại sau khi xong: trả lại phản hồi đã lưu, không chạy lại.
   *  - Gọi lại khi lần đầu chưa xong: trả 409 để client thử lại sau, tránh hai
   *    lần cùng chạy song song rồi tạo ra hai bản ghi.
   */
  async run<T>(options: RunOptions, operation: () => Promise<T>): Promise<T> {
    if (!options.key) return operation();

    const requestHash = this.hash(options.body);

    const existing = await this.prisma.publicApiIdempotencyKey.findUnique({
      where: { clientId_key: { clientId: options.clientId, key: options.key } },
    });

    if (existing) {
      // Cùng khoá nhưng thân request khác nghĩa là client dùng lại khoá cho việc
      // khác. Trả phản hồi cũ lúc này sẽ sai, nên báo lỗi rõ ràng.
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency-Key đã được dùng cho một request khác',
        );
      }
      if (existing.status === 'COMPLETED') return existing.response as T;
      throw new ConflictException(
        'Request với Idempotency-Key này đang được xử lý, vui lòng thử lại sau',
      );
    }

    try {
      await this.prisma.publicApiIdempotencyKey.create({
        data: {
          clientId: options.clientId,
          key: options.key,
          method: options.method,
          path: options.path,
          requestHash,
        },
      });
    } catch {
      // Hai request cùng khoá chạm nhau đúng lúc: ràng buộc unique ở cơ sở dữ
      // liệu là chốt chặn cuối, chỉ một request đi tiếp.
      throw new ConflictException(
        'Request với Idempotency-Key này đang được xử lý, vui lòng thử lại sau',
      );
    }

    try {
      const result = await operation();
      await this.prisma.publicApiIdempotencyKey.update({
        where: { clientId_key: { clientId: options.clientId, key: options.key } },
        data: {
          status: 'COMPLETED',
          statusCode: 200,
          response: result as never,
          completedAt: new Date(),
        },
      });
      return result;
    } catch (error) {
      // Thất bại thì xoá khoá để client sửa dữ liệu rồi gửi lại chính khoá đó.
      // Giữ lại sẽ khoá cứng client khỏi thao tác hợp lệ sau này.
      await this.prisma.publicApiIdempotencyKey
        .delete({ where: { clientId_key: { clientId: options.clientId, key: options.key } } })
        .catch(() => undefined);
      throw error;
    }
  }

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);
    const { count } = await this.prisma.publicApiIdempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  private hash(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }
}
