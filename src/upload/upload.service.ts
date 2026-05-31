import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import convert from 'heic-convert';
import sharp from 'sharp';

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
const PNG_COMPRESSION_LEVEL = 9; // PNG: 0-9 (cao hơn = nén mạnh hơn, chậm hơn)

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

    // Bước 1: nếu là HEIC/HEIF → decode sang JPEG buffer trước (sharp chưa hỗ trợ HEIC mặc định)
    if (HEIC_MIMES.has(mimetype.toLowerCase())) {
      const outputBuffer = await convert({
        buffer: buffer,
        format: 'JPEG',
        quality: 1, // giữ chất lượng tối đa ở bước decode, sẽ nén lại ở sharp
      });
      workingBuffer = Buffer.from(outputBuffer);
    }

    // Bước 2: nén & resize qua sharp
    let pipeline = sharp(workingBuffer, { failOn: 'none' })
      .rotate() // tự xoay theo EXIF orientation rồi mới strip
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      });

    // Quyết định format đầu ra:
    // - HEIC → JPEG (đã decode ở trên)
    // - PNG → giữ PNG (giữ alpha channel)
    // - WEBP → giữ WEBP
    // - JPEG/JPG/khác → JPEG
    let ext: string;
    const lowerMime = mimetype.toLowerCase();
    if (HEIC_MIMES.has(lowerMime)) {
      pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
      ext = '.jpg';
    } else if (lowerMime === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: PNG_COMPRESSION_LEVEL });
      ext = '.png';
    } else if (lowerMime === 'image/webp') {
      pipeline = pipeline.webp({ quality: WEBP_QUALITY });
      ext = '.webp';
    } else {
      // jpeg, jpg, hoặc khác — chuẩn hóa về JPEG
      pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
      ext = '.jpg';
    }

    let finalBuffer: Buffer;
    try {
      finalBuffer = await pipeline.toBuffer();
    } catch (err) {
      this.logger.warn(
        `sharp compress thất bại cho ${originalname}: ${(err as Error).message}. Lưu nguyên buffer gốc.`,
      );
      // Fallback: lưu nguyên buffer ban đầu nếu sharp không xử lý được
      finalBuffer = workingBuffer;
    }

    const filename = `${timestamp}-${randomName}${ext}`;
    const uploadDir = join(process.cwd(), 'uploads', subfolder || '');

    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = join(uploadDir, filename);
    writeFileSync(filePath, finalBuffer);

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
}
