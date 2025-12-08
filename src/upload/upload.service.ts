import { Injectable } from '@nestjs/common';
import { unlink } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class UploadService {
  async deleteFile(filename: string): Promise<void> {
    const filePath = join(process.cwd(), 'uploads', filename);
    try {
      await unlink(filePath);
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  }

  getFileUrl(filename: string): string {
    return `/uploads/${filename}`;
  }
}
