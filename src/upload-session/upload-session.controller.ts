import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { UploadSessionService } from './upload-session.service';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { renderMobileUploadPage } from './mobile-upload.page';

@ApiTags('Upload Sessions')
@Controller('upload-sessions')
export class UploadSessionController {
  constructor(private readonly service: UploadSessionService) {}

  // Tạo phiên — cần đăng nhập (JWT guard toàn cục áp dụng).
  @Post()
  @ApiBearerAuth()
  async create(@Body() dto: CreateUploadSessionDto, @Req() req: any) {
    const userId = req.user?.id as number | undefined;
    const baseUrl = this.resolveBaseUrl(req);
    return this.service.create(dto.subfolder, dto.maxFiles, userId, baseUrl);
  }

  // Máy tính poll trạng thái — cần đăng nhập.
  @Get(':id')
  @ApiBearerAuth()
  async getStatus(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id as number | undefined;
    return this.service.getStatusForOwner(id, userId);
  }

  // Đóng phiên — cần đăng nhập.
  @Post(':id/close')
  @ApiBearerAuth()
  async close(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id as number | undefined;
    return this.service.close(id, userId);
  }

  // Trang upload cho điện thoại — công khai, xác thực bằng token.
  @Public()
  @Get(':id/m')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async mobilePage(
    @Param('id') id: string,
    @Query('t') token: string,
    @Res() res: Response,
  ) {
    if (!token) {
      res.status(400).send(renderMobileUploadPage({ error: 'Thiếu token' }));
      return;
    }
    try {
      await this.service.assertSessionValid(id, token);
      res.status(200).send(
        renderMobileUploadPage({
          id,
          token,
          // Upload về cùng host đang phục vụ trang này (đã qua nginx ở prod).
          uploadPath: `/api/upload-sessions/${id}/images?t=${encodeURIComponent(token)}`,
        }),
      );
    } catch (err) {
      res.status(400).send(
        renderMobileUploadPage({
          error: (err as Error).message || 'Phiên không hợp lệ',
        }),
      );
    }
  }

  // Điện thoại upload ảnh — công khai, xác thực bằng token.
  @Public()
  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('files', 30))
  async uploadImages(
    @Param('id') id: string,
    @Query('t') token: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!token) {
      throw new BadRequestException('Thiếu token');
    }
    if (!files || files.length === 0) {
      throw new BadRequestException('Cần ít nhất 1 file');
    }
    return this.service.addImages(id, token, files);
  }

  /**
   * Dựng base URL cho QR.
   * - Prod: ưu tiên API_URL (domain công khai, qua nginx) nhưng bỏ phần
   *   path "/api" nếu có vì uploadUrl sẽ tự gắn "/api/...".
   * - Dev: dựng từ scheme + host của request (IP LAN máy tính).
   */
  private resolveBaseUrl(req: any): string {
    const apiUrl = process.env.API_URL;
    if (apiUrl) {
      try {
        const u = new URL(apiUrl);
        return `${u.protocol}//${u.host}`;
      } catch {
        return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
      }
    }
    const proto =
      (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ||
      req.protocol ||
      'http';
    const host = (req.headers['x-forwarded-host'] ||
      req.headers['host']) as string;
    return `${proto}://${host}`;
  }
}
