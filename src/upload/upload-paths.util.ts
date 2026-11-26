import { BadRequestException } from '@nestjs/common';
import { resolve, sep } from 'path';
import { ALLOWED_SUBFOLDERS as UPLOAD_SESSION_SUBFOLDERS } from '../upload-session/dto/create-upload-session.dto';

/**
 * Thư mục con được phép ghi dưới uploads/. Đối chiếu với mọi nơi gửi `subfolder`:
 * web, mobile, upload-session (DTO) và các service backend (smax-chat,
 * product-quality). Thêm thư mục mới thì thêm vào đây.
 */
export const ALLOWED_UPLOAD_SUBFOLDERS: ReadonlySet<string> = new Set<string>([
  '',
  'products',
  'products/cong-bo',
  'product-quality',
  'vehicle-shipments',
  'bao-gia',
  'recipes',
  'smax-chat',
  ...UPLOAD_SESSION_SUBFOLDERS,
]);

/** Đuôi file trình duyệt có thể chạy như trang/script → không bao giờ lưu. */
export const BLOCKED_UPLOAD_EXTS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.shtml',
  '.svg',
  '.svgz',
  '.xml',
  '.xsl',
  '.js',
  '.mjs',
  '.cjs',
]);

/** Đuôi file giữ nguyên khi lưu. Đuôi khác (không bị chặn) được lưu thành .bin. */
export const SAFE_UPLOAD_EXTS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.zip',
  '.rar',
]);

const IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
]);

export function uploadRoot(): string {
  return resolve(process.cwd(), 'uploads');
}

/**
 * Trả về thư mục ghi tuyệt đối (nằm trong uploads/) và subfolder đã chuẩn hóa.
 * Subfolder ngoài danh sách cho phép → 400.
 */
export function resolveUploadDir(subfolder?: string | null): {
  dir: string;
  subfolder: string;
} {
  const sub = (subfolder ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!ALLOWED_UPLOAD_SUBFOLDERS.has(sub)) {
    throw new BadRequestException('Thư mục tải lên không hợp lệ');
  }
  const root = uploadRoot();
  const dir = resolve(root, sub);
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new BadRequestException('Thư mục tải lên không hợp lệ');
  }
  return { dir, subfolder: sub };
}

/** Đuôi file (chữ thường, có dấu chấm) hoặc '' nếu không có. */
export function rawExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

export function assertAllowedExtension(filename: string): void {
  const ext = rawExtension(filename);
  if (BLOCKED_UPLOAD_EXTS.has(ext)) {
    throw new BadRequestException(`Không hỗ trợ tải lên tệp ${ext}`);
  }
}

/** Đuôi dùng khi lưu file gốc: chặn đuôi nguy hiểm, giữ đuôi an toàn, còn lại .bin. */
export function safeStoredExtension(originalname: string): string {
  assertAllowedExtension(originalname);
  const ext = rawExtension(originalname);
  return SAFE_UPLOAD_EXTS.has(ext) ? ext : '.bin';
}

/** Đuôi dự phòng khi lưu ảnh không qua sharp: chỉ nhận đuôi ảnh, còn lại .jpg. */
export function safeImageExtension(originalname: string): string {
  const ext = rawExtension(originalname);
  return IMAGE_EXTS.has(ext) ? ext : '.jpg';
}
