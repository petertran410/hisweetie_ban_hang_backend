import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';

@Injectable()
export class UploadService {
  getFileUrl(filename: string, subfolder?: string): string {
    const baseUrl = process.env.API_URL || 'http://localhost:3060';
    const path = subfolder ? `${subfolder}/${filename}` : filename;
    return `${baseUrl}/uploads/${path}`;
  }

  async deleteFile(filename: string): Promise<void> {
    const filePath = join(process.cwd(), 'uploads', filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
