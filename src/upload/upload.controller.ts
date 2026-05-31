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
      throw new BadRequestException('Only image files are allowed');
    }

    const result = await this.uploadService.saveImage(
      file.buffer,
      file.originalname,
      file.mimetype,
      subfolder,
    );

    return result;
  }

  @Post('images')
  @UseInterceptors(FilesInterceptor('files', 20))
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
          reason: 'Only image files are allowed',
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
      } catch {
        errors.push({
          originalname: file.originalname,
          reason: 'Upload failed',
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
