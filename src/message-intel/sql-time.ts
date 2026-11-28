import { Prisma } from '@prisma/client';

/**
 * Mốc thời gian cho `$queryRaw` khi so / ghi cột TIMESTAMP (không múi giờ) chứa giờ UTC như Prisma ghi.
 * Prisma gửi Date dạng timestamptz → Postgres đổi cột theo múi giờ của phiên (production: Asia/Ho_Chi_Minh)
 * → lệch 7 giờ. Đổi tham số về giờ UTC không múi giờ để đúng với mọi múi giờ phiên.
 */
export const utcTs = (d: Date) =>
  Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
