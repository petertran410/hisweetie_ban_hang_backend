import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { AllowedSubfolder } from './dto/create-upload-session.dto';

// Thời hạn 1 phiên (ms). Postgres không có TTL nên kiểm tra bằng code.
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 phút
const DEFAULT_MAX_FILES = 30;

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    private prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

  /** Tạo phiên upload mới, trả về session + uploadUrl để encode QR. */
  async create(
    subfolder: AllowedSubfolder,
    maxFiles: number | undefined,
    createdById: number | undefined,
    baseUrl: string,
  ) {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const session = await this.prisma.uploadSession.create({
      data: {
        token,
        subfolder,
        maxFiles: maxFiles ?? DEFAULT_MAX_FILES,
        createdById: createdById ?? null,
        expiresAt,
        images: [],
      },
    });

    return {
      id: session.id,
      token: session.token,
      uploadUrl: this.buildUploadUrl(baseUrl, session.id, session.token),
      maxFiles: session.maxFiles,
      expiresAt: session.expiresAt,
    };
  }

  /** Trạng thái phiên cho máy tính poll. Chỉ chủ phiên được xem. */
  async getStatusForOwner(id: string, userId: number | undefined) {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id },
    });
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên upload');
    }
    // Nếu phiên có chủ thì chỉ chủ mới xem được; phiên không chủ (createdById
    // null) thì bỏ qua kiểm tra để không chặn nhầm.
    if (
      session.createdById != null &&
      userId != null &&
      session.createdById !== userId
    ) {
      throw new ForbiddenException('Không có quyền với phiên này');
    }

    const expired = session.expiresAt.getTime() < Date.now();
    return {
      id: session.id,
      status: expired ? 'expired' : session.status,
      images: (session.images as string[]) ?? [],
      maxFiles: session.maxFiles,
      expiresAt: session.expiresAt,
    };
  }

  /** Lấy phiên hợp lệ theo token (dùng cho route công khai của điện thoại). */
  private async getValidSessionByToken(id: string, token: string) {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id },
    });
    if (!session || session.token !== token) {
      throw new NotFoundException('Phiên upload không tồn tại hoặc sai token');
    }
    if (session.status !== 'active') {
      throw new BadRequestException('Phiên upload đã đóng');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Phiên upload đã hết hạn');
    }
    return session;
  }

  /** Kiểm tra token hợp lệ (cho trang HTML của điện thoại). */
  async assertSessionValid(id: string, token: string) {
    await this.getValidSessionByToken(id, token);
    return true;
  }

  /** Điện thoại upload ảnh vào phiên. */
  async addImages(
    id: string,
    token: string,
    files: Express.Multer.File[],
  ): Promise<{
    items: { filename: string; url: string; size: number }[];
    errors: { originalname: string; reason: string }[];
  }> {
    const session = await this.getValidSessionByToken(id, token);

    const current = (session.images as string[]) ?? [];
    const remaining = session.maxFiles - current.length;
    if (remaining <= 0) {
      throw new BadRequestException(
        `Phiên đã đạt giới hạn ${session.maxFiles} ảnh`,
      );
    }

    const items: { filename: string; url: string; size: number }[] = [];
    const errors: { originalname: string; reason: string }[] = [];

    for (const file of files) {
      if (items.length >= remaining) {
        errors.push({
          originalname: file.originalname,
          reason: `Vượt giới hạn ${session.maxFiles} ảnh của phiên`,
        });
        continue;
      }
      if (!ALLOWED_MIMES.has(file.mimetype.toLowerCase())) {
        errors.push({
          originalname: file.originalname,
          reason: `Mime type không được hỗ trợ: ${file.mimetype}`,
        });
        continue;
      }
      try {
        const result = await this.uploadService.saveImage(
          file.buffer,
          file.originalname,
          file.mimetype,
          session.subfolder,
        );
        items.push(result);
      } catch (err) {
        const message = (err as Error).message || 'Unknown error';
        this.logger.error(
          `Upload session ${id} — file lỗi: name=${file.originalname} mime=${file.mimetype} → ${message}`,
          (err as Error).stack,
        );
        errors.push({ originalname: file.originalname, reason: message });
      }
    }

    if (items.length > 0) {
      const updated = [...current, ...items.map((it) => it.url)];
      await this.prisma.uploadSession.update({
        where: { id },
        data: { images: updated },
      });
    }

    return { items, errors };
  }

  /** Đóng phiên (tùy chọn, gọi khi máy tính đóng modal). */
  async close(id: string, userId: number | undefined) {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id },
    });
    if (!session) return { ok: true };
    if (
      session.createdById != null &&
      userId != null &&
      session.createdById !== userId
    ) {
      throw new ForbiddenException('Không có quyền với phiên này');
    }
    await this.prisma.uploadSession.update({
      where: { id },
      data: { status: 'closed' },
    });
    return { ok: true };
  }

  /** Dọn các phiên đã hết hạn (đánh dấu closed). */
  async cleanupExpired(): Promise<number> {
    const res = await this.prisma.uploadSession.updateMany({
      where: { status: 'active', expiresAt: { lt: new Date() } },
      data: { status: 'closed' },
    });
    return res.count;
  }

  private buildUploadUrl(baseUrl: string, id: string, token: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    return `${base}/api/upload-sessions/${id}/m?t=${token}`;
  }
}
