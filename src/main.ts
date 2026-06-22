import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import helmet from 'helmet';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Tin tưởng reverse proxy phía trước (nginx publish 3060:80, app chỉ
  // expose nội bộ trong hisweetie-network → mọi request đều qua đúng 1 hop nginx).
  // Đặt = 1 (KHÔNG dùng true) để express lấy IP do nginx ghi nhận, chống
  // client giả mạo header X-Forwarded-For nhằm né rate-limit.
  app.set('trust proxy', 1);

  // Security headers (chống clickjacking, MIME-sniffing, ...).
  // - contentSecurityPolicy: tắt vì app có Swagger UI và phục vụ ảnh tĩnh
  //   cho frontend ở domain khác; bật CSP mặc định dễ chặn nhầm.
  // - crossOriginResourcePolicy cross-origin: cho phép frontend khác origin
  //   tải ảnh trong /uploads/.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.useBodyParser('json', { limit: '20mb' });
  // text/plain cho nguồn ngoài gửi tin nhắn thô (vd MacroDroid) — không bọc JSON.
  app.useBodyParser('text', { type: ['text/plain'], limit: '1mb' });

  app.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins =
        process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) || [];

      if (!origin) {
        return callback(null, true);
      }

      try {
        const url = new URL(origin);
        const isAllowed = allowedOrigins.some((allowedOrigin) => {
          if (allowedOrigin === origin) return true;

          try {
            const allowedUrl = new URL(allowedOrigin);
            if (
              allowedUrl.hostname === 'localhost' &&
              url.hostname === 'localhost'
            ) {
              return true;
            }
          } catch {
            if (allowedOrigin === '*') return true;
          }

          return false;
        });

        if (isAllowed) {
          callback(null, true);
        } else {
          console.warn(
            `CORS: Rejected origin ${origin}. Allowed: ${allowedOrigins.join(', ')}`,
          );
          callback(null, false);
        }
      } catch (error) {
        console.warn(`CORS: Invalid origin format ${origin}`);
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-CSRF-Token',
      'Accept',
      'Origin',
      'X-Force-Signature',
      'X-Site-Code',
      'X-Branch-Id',
    ],
    exposedHeaders: ['Set-Cookie'],
    maxAge: 86400,
    optionsSuccessStatus: 200,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const uploadsPath = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsPath)) {
    mkdirSync(uploadsPath, { recursive: true });
  }

  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads/',
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3060;
  await app.listen(port);
  console.log(
    `CORS allowed origins: ${process.env.CORS_ORIGIN || 'None set - requests may be blocked'}`,
  );
}
bootstrap();
