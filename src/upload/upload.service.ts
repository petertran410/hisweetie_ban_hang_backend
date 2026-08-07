import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import convert from 'heic-convert';

const HEIC_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

// Cấu hình nén ảnh
const MAX_DIMENSION = 1920; // Resize chiều dài/rộng tối đa
const JPEG_QUALITY = 80;
const WEBP_QUALITY = 80;
const PNG_COMPRESSION_LEVEL = 9;

// Lazy-load sharp để nếu binary lỗi thì cả ứng dụng không crash khi import
type SharpFn = typeof import('sharp');
let sharpModule: SharpFn | null = null;
let sharpLoadError: Error | null = null;
function getSharp(): SharpFn | null {
  if (sharpModule) return sharpModule;
  if (sharpLoadError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharpModule = require('sharp') as SharpFn;
    return sharpModule;
  } catch (err) {
    sharpLoadError = err as Error;
    return null;
  }
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  getFileUrl(filename: string, subfolder?: string): string {
    const baseUrl = process.env.API_URL || 'http://localhost:3060';
    const path = subfolder ? `${subfolder}/${filename}` : filename;
    return `${baseUrl}/uploads/${path}`;
  }

  async saveImage(
    buffer: Buffer,
    originalname: string,
    mimetype: string,
    subfolder?: string,
  ): Promise<{ filename: string; url: string; size: number }> {
    const timestamp = Date.now();
    const randomName = Array(16)
      .fill(null)
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join('');

    let workingBuffer: Buffer = buffer;
    const isHeic = HEIC_MIMES.has(mimetype.toLowerCase());

    // Bước 1: nếu HEIC/HEIF → decode sang JPEG buffer.
    // Ưu tiên sharp (native libheif, nhanh); chỉ fallback heic-convert (JS thuần,
    // chậm 3–10s/ảnh) khi sharp không đọc được HEIC trên môi trường này.
    if (isHeic) {
      let decoded = false;
      const sharpForHeic = getSharp();

      if (sharpForHeic) {
        try {
          workingBuffer = await sharpForHeic(buffer, { failOn: 'none' })
            .jpeg({ quality: 92 })
            .toBuffer();
          decoded = true;
        } catch (err) {
          this.logger.warn(
            `sharp không decode được HEIC ${originalname} (${(err as Error).message}). Fallback heic-convert.`,
          );
        }
      }

      if (!decoded) {
        try {
          const outputBuffer = await convert({
            buffer: buffer,
            format: 'JPEG',
            // 0.92 thay vì 1: sharp sẽ nén lại JPEG_QUALITY ở bước 2 nên giữ
            // quality tối đa ở đây chỉ tốn thời gian, không thêm chất lượng.
            quality: 0.92,
          });
          workingBuffer = Buffer.from(outputBuffer);
        } catch (err) {
          this.logger.error(
            `HEIC convert thất bại cho ${originalname}: ${(err as Error).message}`,
            (err as Error).stack,
          );
          throw new Error(`HEIC decode failed: ${(err as Error).message}`);
        }
      }
    }

    // Bước 2: nén & resize qua sharp (nếu sharp khả dụng)
    const sharp = getSharp();
    let finalBuffer: Buffer = workingBuffer;
    let ext: string;
    const lowerMime = mimetype.toLowerCase();

    if (sharp) {
      try {
        let pipeline = sharp(workingBuffer, { failOn: 'none' })
          .rotate()
          .resize({
            width: MAX_DIMENSION,
            height: MAX_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true,
          });

        if (isHeic) {
          pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
          ext = '.jpg';
        } else if (lowerMime === 'image/png') {
          pipeline = pipeline.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
          ext = '.png';
        } else if (lowerMime === 'image/webp') {
          pipeline = pipeline.webp({ quality: WEBP_QUALITY });
          ext = '.webp';
        } else {
          pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
          ext = '.jpg';
        }

        finalBuffer = await pipeline.toBuffer();
      } catch (err) {
        this.logger.warn(
          `sharp compress thất bại cho ${originalname} (mime=${mimetype}): ${(err as Error).message}. Lưu nguyên buffer.`,
        );
        // Fallback: dùng buffer chưa nén
        ext = isHeic ? '.jpg' : this.extFromMime(lowerMime, originalname);
      }
    } else {
      // sharp không tải được → log 1 lần, vẫn lưu file
      if (sharpLoadError) {
        this.logger.warn(
          `sharp không khả dụng (${sharpLoadError.message}). Lưu ảnh không nén.`,
        );
      }
      ext = isHeic ? '.jpg' : this.extFromMime(lowerMime, originalname);
    }

    const filename = `${timestamp}-${randomName}${ext}`;
    const uploadDir = join(process.cwd(), 'uploads', subfolder || '');

    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = join(uploadDir, filename);
    try {
      await writeFile(filePath, finalBuffer);
    } catch (err) {
      this.logger.error(
        `Ghi file thất bại ${filePath}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new Error(`Write file failed: ${(err as Error).message}`);
    }

    return {
      filename,
      url: this.getFileUrl(filename, subfolder),
      size: finalBuffer.length,
    };
  }

  async deleteFile(filename: string): Promise<void> {
    const filePath = join(process.cwd(), 'uploads', filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  /**
   * Lưu file gốc (không nén, không resize). Dùng cho file PDF, doc, xls, csv,...
   * và cả ảnh trong trường hợp cần giữ nguyên file.
   */
  async saveFile(
    buffer: Buffer,
    originalname: string,
    mimetype: string,
    subfolder?: string,
  ): Promise<{
    filename: string;
    url: string;
    size: number;
    mimetype: string;
    originalname: string;
  }> {
    const timestamp = Date.now();
    const randomName = Array(16)
      .fill(null)
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join('');

    const idx = originalname.lastIndexOf('.');
    const ext = idx >= 0 ? originalname.slice(idx).toLowerCase() : '';
    const filename = `${timestamp}-${randomName}${ext}`;

    const uploadDir = join(process.cwd(), 'uploads', subfolder || '');
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = join(uploadDir, filename);
    try {
      await writeFile(filePath, buffer);
    } catch (err) {
      this.logger.error(
        `Ghi file thất bại ${filePath}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new Error(`Write file failed: ${(err as Error).message}`);
    }

    return {
      filename,
      url: this.getFileUrl(filename, subfolder),
      size: buffer.length,
      mimetype,
      originalname,
    };
  }

  private extFromMime(mime: string, originalname: string): string {
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
    // fallback: lấy theo originalname
    const idx = originalname.lastIndexOf('.');
    if (idx >= 0) return originalname.slice(idx).toLowerCase();
    return '.jpg';
  }
}
