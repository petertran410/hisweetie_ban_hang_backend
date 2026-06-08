import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Chặn sớm các request dò quét file/đường dẫn nhạy cảm (vulnerability scanner).
 *
 * Bot tự động thường dò các path như /.env, /.git/config, /.aws/credentials,
 * /wp-config.php, /actuator/env ... để tìm file lộ secret. Vì app dùng global
 * prefix /api nên các path này luôn 404, nhưng chúng vẫn đi qua toàn bộ pipeline
 * và làm lụt log. Middleware này trả 403 ngay lập tức, ghi 1 dòng log gọn kèm IP
 * để dễ truy nguồn, giúp giảm tải và làm sạch log.
 */
@Injectable()
export class BlockScannerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('ScannerBlock');

  // Các pattern path đặc trưng của bot quét. Khớp không phân biệt hoa thường.
  private static readonly BLOCKED_PATTERNS: RegExp[] = [
    /\.env($|[./~])/i, // .env, .env.local, .env.bak, .env/...
    /\.git(\/|$)/i, // .git/config, .git/
    /\.ssh(\/|$)/i, // .ssh/id_rsa
    /\.aws(\/|$)/i, // .aws/credentials
    /\.azure(\/|$)/i,
    /\.gcloud(\/|$)/i,
    /\.docker(\/|$)/i,
    /\.vscode(\/|$)/i,
    /\.idea(\/|$)/i,
    /\.htaccess|\.htpasswd|\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.bash_history|\.credentials/i,
    /wp-config\.php|wp-login|xmlrpc\.php/i,
    /phpinfo|\/php\.php|\/test\.php|\/info\.php/i,
    /\/actuator(\/|$)|\/_profiler|\/profiler/i,
    /\/(heapdump|threaddump|configprops|env|trace|dump|logfile)$/i,
    /docker-compose|Dockerfile|terraform\.tf|kubernetes|\/helm\//i,
    /\/(id_rsa|private\.key|private_key\.pem|server\.key|server\.pem)$/i,
    /\.(sql|sql\.gz)$/i, // dump.sql, db.sql.gz
    /\/(backup|dump|db|database|secrets?|credentials|config)\.(zip|tar\.gz|tar\.bz2|json|yml|yaml|php|ini)$/i,
    /\/(secrets?|credentials|service-account|appsettings|application)\.(json|ya?ml|properties)$/i,
    /\/settings\.py$|\/config\.php$|\/database\.php$/i,
    /\.(bak|old|orig|save|swp)$/i, // các file backup tổng quát
  ];

  use(req: Request, res: Response, next: NextFunction) {
    const path = req.path || req.url;

    const isBlocked = BlockScannerMiddleware.BLOCKED_PATTERNS.some((re) =>
      re.test(path),
    );

    if (isBlocked) {
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        'unknown';
      const ua = req.headers['user-agent'] || '-';
      this.logger.warn(`Blocked scan ${req.method} ${path} - IP ${ip} - UA "${ua}"`);
      res.status(403).json({ statusCode: 403, message: 'Forbidden' });
      return;
    }

    next();
  }
}
