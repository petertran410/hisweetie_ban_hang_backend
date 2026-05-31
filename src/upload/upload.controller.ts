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

    for (const file of files) {
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
          subfolder,
        );
        items.push(result);
      } catch (err) {
        const message = (err as Error).message || 'Unknown error';
        this.logger.error(
          `Upload images batch — file lỗi: name=${file.originalname} mime=${file.mimetype} size=${file.size} subfolder=${subfolder} → ${message}`,
          (err as Error).stack,
        );
        errors.push({
          originalname: file.originalname,
          reason: message,
        });
      }
    }

    return { items, errors };
  }

  @Delete(':filename')
  async deleteFile(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename);
    return { message: 'File deleted successfully' };
  }
}
