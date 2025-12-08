import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Delete,
  Param,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private uploadService: UploadService) {}

  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('Only image files are allowed');
    }

    return {
      filename: file.filename,
      url: this.uploadService.getFileUrl(file.filename),
      size: file.size,
    };
  }

  @Delete(':filename')
  async deleteFile(@Param('filename') filename: string) {
    await this.uploadService.deleteFile(filename);
    return { message: 'File deleted successfully' };
  }
}
