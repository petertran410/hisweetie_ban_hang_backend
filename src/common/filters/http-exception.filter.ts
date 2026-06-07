import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
} from '@prisma/client/runtime/library';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getResponse();
    } else if (exception instanceof PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        const target = (exception.meta?.target as string[]) || [];
        message = {
          statusCode: status,
          message: `Trường ${target.join(', ')} đã tồn tại`,
          error: 'Conflict',
        };
      } else if (exception.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST;
        message = {
          statusCode: status,
          message: 'Dữ liệu tham chiếu không tồn tại',
          error: 'Bad Request',
        };
      }
    } else if (exception instanceof PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = {
        statusCode: status,
        message: 'Dữ liệu không hợp lệ',
        error: 'Bad Request',
      };
    }

    // Chỉ log error (kèm stack) cho lỗi server (5xx) hoặc exception không xác định.
    // Lỗi client 4xx là hành vi mong đợi (validation, không tìm thấy, ...) → log gọn 1 dòng.
    // Riêng 401/403 (chưa đăng nhập / không có quyền) bỏ qua hẳn để tránh lụt log.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : exception,
      );
    } else if (
      status !== HttpStatus.UNAUTHORIZED &&
      status !== HttpStatus.FORBIDDEN
    ) {
      // Trích message gọn để log dễ debug (vd lý do bị chặn khi hủy phiếu)
      const reason =
        typeof message === 'string'
          ? message
          : (message?.message ?? '');
      this.logger.warn(
        `${request.method} ${request.url} ${status}${reason ? ` - ${reason}` : ''}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
