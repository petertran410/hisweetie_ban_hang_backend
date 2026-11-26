import type { NextFunction, Request, Response } from 'express';
import { posix } from 'path';

/**
 * Thư mục dưới uploads/ KHÔNG được phục vụ công khai (chỉ đọc từ đĩa qua API
 * đã kiểm quyền). contracts: PDF hợp đồng đã ký, tải qua /api/contracts/:id/download.
 */
const PRIVATE_UPLOAD_PREFIXES = ['/contracts'];

/**
 * true  → đường dẫn thuộc thư mục riêng tư,
 * false → được phục vụ bình thường,
 * null  → đường dẫn hỏng (mã hóa sai, ký tự NUL).
 *
 * Phải giải mã + chuẩn hóa trước khi so sánh vì express static tự giải mã
 * (`/a/..%2Fcontracts/x.pdf` → `/contracts/x.pdf`).
 */
export function isPrivateUploadPath(rawPath: string): boolean | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalized = posix
    .normalize('/' + decoded.replace(/\\/g, '/'))
    .toLowerCase();
  return PRIVATE_UPLOAD_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + '/'),
  );
}

/** Gắn tại '/uploads' trước static: thư mục riêng tư → 404, đường dẫn hỏng → 400. */
export function privateUploadsGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const verdict = isPrivateUploadPath(req.path);
  if (verdict === null) {
    res.status(400).end();
    return;
  }
  if (verdict) {
    res.status(404).end();
    return;
  }
  next();
}
