import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { UploadSessionService } from './upload-session.service';

/**
 * Kiểm token phiên upload của điện thoại (route công khai). Guard chạy TRƯỚC
 * interceptor nên request sai/thiếu token bị từ chối trước khi multer đọc file
 * vào RAM. Chỉ kiểm token phiên, không liên quan phân quyền người dùng.
 */
@Injectable()
export class UploadSessionTokenGuard implements CanActivate {
  constructor(private readonly service: UploadSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = typeof req.query?.t === 'string' ? req.query.t : '';
    if (!token) {
      throw new BadRequestException('Thiếu token');
    }
    await this.service.assertSessionValid(String(req.params?.id ?? ''), token);
    return true;
  }
}
