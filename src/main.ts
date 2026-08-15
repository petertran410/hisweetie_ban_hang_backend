import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import helmet from 'helmet';
import * as compression from 'compression';

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

  // Nén response (gzip/deflate). Login trả về permissions[]/roles[] khá lớn;
  // nén giúp client mạng yếu / latency cao nhận đủ body nhanh hơn, giảm rủi ro
  // đứt giữa chừng trên chuỗi proxy nhiều hop.
  app.use(compression());

  app.useBodyParser('json', { limit: '20mb' });
  // OAuth 2.0 client-credentials libraries commonly submit form-urlencoded bodies.
  app.useBodyParser('urlencoded', { extended: true, limit: '20mb' });
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
      'X-Request-Id',
      'Idempotency-Key',
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

  // Tên file upload là `${timestamp}-${random}${ext}` → không bao giờ bị ghi đè,
  // nên cache vĩnh viễn an toàn. Tránh việc mở lại phiếu cũ phải tải lại ảnh.
  app.useStaticAssets(uploadsPath, {
    prefix: '/uploads/',
    maxAge: '1y',
    immutable: true,
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3060;
  const server = await app.listen(port);
  // Chuỗi proxy trước app: Cloudflare (proxied) → NAS public (Synology
  // Reverse Proxy) → nginx container (keepalive_timeout rất lớn) → Node.
  // Node default keepAliveTimeout=5s → NHỎ NHẤT trong chuỗi: sau 5s idle Node
  // đóng TCP trong khi các layer trên vẫn giữ connection để tái sử dụng, khiến
  // request kế tiếp (đặc biệt từ client latency cao) rơi vào socket đã chết →
  // ERR_CONNECTION_CLOSED. Nâng lên 65s để Node KHÔNG phải là bên đóng trước.
  // headersTimeout phải > keepAliveTimeout để tránh race đóng khi đang đọc header.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  console.log(
    `CORS allowed origins: ${process.env.CORS_ORIGIN || 'None set - requests may be blocked'}`,
  );
}
bootstrap();
