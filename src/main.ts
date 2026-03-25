import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(
    `CORS allowed origins: ${process.env.CORS_ORIGIN || 'None set - requests may be blocked'}`,
  );
}
bootstrap();
