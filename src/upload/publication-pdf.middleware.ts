import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { stat, readFile } from 'fs/promises';
import { join } from 'path';
import {
  contentDispositionInline,
  matchPublicationPdfRequest,
  publicationDisplayName,
  stampPdfTitle,
} from './publication-pdf-title';

const MAX_CACHED_PDFS = 8;
const MAX_CACHED_PDF_BYTES = 12 * 1024 * 1024;

export interface PublicationPdfMiddlewareOptions {
  directory: string;
  findOriginalName: (storedFilename: string) => Promise<string | null>;
}

/**
 * Trả PDF công bố với /Title = tên gốc, nhưng URL vẫn là file đang lưu.
 * File trên đĩa không bị sửa. Lỗi thì nhường cho static handler.
 */
export function createPublicationPdfMiddleware(
  options: PublicationPdfMiddlewareOptions,
) {
  const logger = new Logger('PublicationPdf');
  const cache = new Map<string, Buffer>();

  return async (req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent || res.writableEnded) return;

    const storedFilename = matchPublicationPdfRequest(req.method, req.path);
    if (!storedFilename) return next();

    const filePath = join(options.directory, storedFilename);
    let fileStat: { mtimeMs: number; size: number };
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return next();
      logger.warn(
        `Không đọc được ${storedFilename}: ${(error as Error).message}`,
      );
      return next();
    }

    if (!fileStat || !fileStat.size) return next();

    let displayName: string | null = null;
    try {
      displayName = publicationDisplayName(
        await options.findOriginalName(storedFilename),
      );
    } catch (error) {
      logger.warn(
        `Không lấy được tên gốc ${storedFilename}: ${(error as Error).message}`,
      );
      return next();
    }
    if (!displayName) return next();

    try {
      const cacheKey = `${storedFilename}\0${fileStat.mtimeMs}\0${fileStat.size}\0${displayName}`;
      let body = cache.get(cacheKey);
      if (!body) {
        const stamped = await stampPdfTitle(
          await readFile(filePath),
          displayName,
        );
        body = Buffer.from(stamped);
        remember(cache, cacheKey, body);
      }

      if (res.headersSent || res.writableEnded) return;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', body.length);
      res.setHeader(
        'Content-Disposition',
        contentDispositionInline(displayName),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Accept-Ranges', 'none');
      res.status(200);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      logger.warn(
        `Giữ nguyên file ${storedFilename}: ${(error as Error).message}`,
      );
      if (!res.headersSent && !res.writableEnded) next();
    }
  };
}

function remember(cache: Map<string, Buffer>, key: string, body: Buffer) {
  if (body.length > MAX_CACHED_PDF_BYTES) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, body);
  while (cache.size > MAX_CACHED_PDFS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
