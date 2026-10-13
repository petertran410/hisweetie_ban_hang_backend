import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "Chốt chuyển đổi": từ thời điểm này POS là nơi ghi sổ chính. Đồng bộ dữ liệu
 * cũ bị khóa (chạy lại sẽ trùng với dữ liệu POS tự sinh) và POS ngừng đẩy phí
 * báo đơn sang hệ thống cũ.
 */
@Injectable()
export class FinanceCutoverService {
  constructor(private readonly prisma: PrismaService) {}

  async status() {
    const settings = await this.prisma.settings.findFirst({
      select: { financeCutoverAt: true },
    });
    return {
      locked: Boolean(settings?.financeCutoverAt),
      cutoverAt: settings?.financeCutoverAt ?? null,
    };
  }

  async assertOpen() {
    if ((await this.status()).locked)
      throw new BadRequestException(
        'Đã chốt chuyển đổi: không đồng bộ dữ liệu cũ nữa để tránh trùng',
      );
  }

  async set(locked: boolean, user: { roles?: string[] }) {
    if (!user?.roles?.includes('Super Admin'))
      throw new ForbiddenException('Chỉ Super Admin được chốt chuyển đổi');
    const settings = await this.prisma.settings.findFirst({
      select: { id: true },
    });
    if (!settings) throw new BadRequestException('Chưa có cài đặt hệ thống');
    await this.prisma.settings.update({
      where: { id: settings.id },
      data: { financeCutoverAt: locked ? new Date() : null },
    });
    return this.status();
  }
}
