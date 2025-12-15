import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unlink } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class UploadService {
  constructor(private configService: ConfigService) {}

  async deleteFile(filename: string): Promise<void> {
    const filePath = join(process.cwd(), 'uploads', filename);
    try {
      await unlink(filePath);
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  }

  getFileUrl(filename: string): string {
    const baseUrl =
      this.configService.get('API_BASE_URL') || 'http://localhost:3060';
    return `${baseUrl}/uploads/${filename}`;
  }
}
