import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  BadRequestException,
  Delete,
  Param,
  Query,
  Logger,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

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

// Cho phép cả ảnh + tài liệu (pdf, doc, xls, csv, txt, zip, ...) — dùng cho file
// chứng từ chi phí, không qua pipeline xử lý ảnh.
const ALLOWED_FILE_MIMES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  // Videos
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
]);

@Controller('upload')
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  constructor(private uploadService: UploadService) {}

  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query('subfolder') subfolder?: string,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!ALLOWED_MIMES.has(file.mimetype.toLowerCase())) {
      throw new BadRequestException(
        `Mime type không được hỗ trợ: ${file.mimetype}`,
      );
    }

    try {
      return await this.uploadService.saveImage(
        file.buffer,
        file.originalname,
        file.mimetype,
        subfolder,
      );
    } catch (err) {
      this.logger.error(
        `Upload image thất bại: name=${file.originalname} mime=${file.mimetype} size=${file.size} subfolder=${subfolder} → ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  @Post('images')
  @UseInterceptors(FilesInterceptor('files', 30))
  async uploadImages(
    @UploadedFiles() files: Express.Multer.File[],
    @Query('subfolder') subfolder?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const items: { filename: string; url: string; size: number }[] = [];
    const errors: { originalname: string; reason: string }[] = [];

    // Xử lý SONG SONG: mỗi ảnh phải qua HEIC-decode + sharp resize (tốn CPU và
    // có await I/O). Chạy tuần tự thì upload 3 ảnh mất ~3× thời gian 1 ảnh.
    // Dùng settled[] theo index để thứ tự items khớp thứ tự file gửi lên.
    type ImageSettled = {
      item?: { filename: string; url: string; size: number };
      error?: { originalname: string; reason: string };
    };
    const settled = await Promise.all(
      files.map(async (file): Promise<ImageSettled> => {
        if (!ALLOWED_MIMES.has(file.mimetype.toLowerCase())) {
          return {
            error: {
              originalname: file.originalname,
              reason: `Mime type không được hỗ trợ: ${file.mimetype}`,
            },
          };
        }

        try {
          const result = await this.uploadService.saveImage(
            file.buffer,
            file.originalname,
            file.mimetype,
            subfolder,
          );
          return { item: result };
        } catch (err) {
          const message = (err as Error).message || 'Unknown error';
          this.logger.error(
            `Upload images batch — file lỗi: name=${file.originalname} mime=${file.mimetype} size=${file.size} subfolder=${subfolder} → ${message}`,
            (err as Error).stack,
          );
          return {
            error: { originalname: file.originalname, reason: message },
          };
        }
      }),
    );

    for (const r of settled) {
      if (r.item) items.push(r.item);
      else if (r.error) errors.push(r.error);
    }

    return { items, errors };
  }

  @Delete(':filename')
  async deleteFile(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename);
    return { message: 'File deleted successfully' };
  }

  @Post('file')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAnyFile(
    @UploadedFile() file: Express.Multer.File,
    @Query('subfolder') subfolder?: string,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!ALLOWED_FILE_MIMES.has(file.mimetype.toLowerCase())) {
      throw new BadRequestException(
        `Mime type không được hỗ trợ: ${file.mimetype}. Hỗ trợ: ảnh (jpeg/png/webp/gif/heic), video (mp4/webm/quicktime/x-m4v), tài liệu (pdf/doc/xls/ppt/txt/csv/zip).`,
      );
    }

    try {
      return await this.uploadService.saveFile(
        file.buffer,
        file.originalname,
        file.mimetype,
        subfolder,
      );
    } catch (err) {
      this.logger.error(
        `Upload file thất bại: name=${file.originalname} mime=${file.mimetype} size=${file.size} subfolder=${subfolder} → ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }

  @Post('files')
  @UseInterceptors(FilesInterceptor('files', 30))
  async uploadAnyFiles(
    @UploadedFiles() files: Express.Multer.File[],
    @Query('subfolder') subfolder?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const items: {
      filename: string;
      url: string;
      size: number;
      mimetype: string;
      originalname: string;
    }[] = [];
    const errors: { originalname: string; reason: string }[] = [];

    // Xử lý song song (xem ghi chú ở uploadImages).
    type FileSettled = {
      item?: {
        filename: string;
        url: string;
        size: number;
        mimetype: string;
        originalname: string;
      };
      error?: { originalname: string; reason: string };
    };
    const settled = await Promise.all(
      files.map(async (file): Promise<FileSettled> => {
        if (!ALLOWED_FILE_MIMES.has(file.mimetype.toLowerCase())) {
          return {
            error: {
              originalname: file.originalname,
              reason: `Mime type không được hỗ trợ: ${file.mimetype}. Hỗ trợ: ảnh (jpeg/png/webp/gif/heic), video (mp4/webm/quicktime/x-m4v), tài liệu (pdf/doc/xls/ppt/txt/csv/zip).`,
            },
          };
        }

        try {
          const result = await this.uploadService.saveFile(
            file.buffer,
            file.originalname,
            file.mimetype,
            subfolder,
          );
          return { item: result };
        } catch (err) {
          const message = (err as Error).message || 'Unknown error';
          this.logger.error(
            `Upload files batch — file lỗi: name=${file.originalname} mime=${file.mimetype} size=${file.size} subfolder=${subfolder} → ${message}`,
            (err as Error).stack,
          );
          return {
            error: { originalname: file.originalname, reason: message },
          };
        }
      }),
    );

    for (const r of settled) {
      if (r.item) items.push(r.item);
      else if (r.error) errors.push(r.error);
    }

    return { items, errors };
  }
}
