/**
 * Kiểm tra origin có nằm trong CORS_ORIGIN (phân tách bằng dấu phẩy) không.
 * Dùng chung cho HTTP (main.ts) và WebSocket gateway.
 * - Không có origin (server-to-server, curl) → cho phép.
 * - localhost khớp mọi port nếu CORS_ORIGIN có 1 origin localhost.
 * - '*' → cho phép tất cả.
 */
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;

  const allowedOrigins =
    process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) || [];

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    console.warn(`CORS: Invalid origin format ${origin}`);
    return false;
  }

  const isAllowed = allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === origin) return true;
    try {
      const allowedUrl = new URL(allowedOrigin);
      if (allowedUrl.hostname === 'localhost' && url.hostname === 'localhost') {
        return true;
      }
    } catch {
      if (allowedOrigin === '*') return true;
    }
    return false;
  });

  if (!isAllowed) {
    console.warn(
      `CORS: Rejected origin ${origin}. Allowed: ${allowedOrigins.join(', ')}`,
    );
  }
  return isAllowed;
}
