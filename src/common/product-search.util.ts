// ====================================================================
// NGUỒN CHÂN LÝ DUY NHẤT cho TÌM KIẾM SẢN PHẨM theo tên / mã.
//
// Quy tắc khớp (mỗi token tách theo khoảng trắng):
// - Trên `name`: token phải khớp NHƯ MỘT TỪ TRỌN VẸN nhờ ranh giới từ
//   `\m...\M` của Postgres regex (vẫn unaccent nên gõ không dấu vẫn ra).
//   Tránh việc token ngắn (vd "le") khớp nhầm chuỗi con bên trong một từ
//   khác — điển hình là thương hiệu "Lermao" có ở mọi tên sản phẩm.
// - Trên `code`: vẫn khớp chuỗi con (mã không phải từ có dấu cách).
// - Nhiều token → giao (AND): sản phẩm phải chứa TẤT CẢ các từ, không phụ
//   thuộc thứ tự gõ.
//
// Dùng chung cho mọi endpoint tìm sản phẩm (products, price-books...) để
// đảm bảo một hành vi tìm kiếm nhất quán toàn hệ thống.
// ====================================================================

import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Escape ký tự đặc biệt của POSIX regex để từ khóa người dùng không phá cú
// pháp regex (vd khi gõ "100gr ( 8" có dấu ngoặc).
const escapeRegex = (t: string) => t.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');

// Token ngắn hơn ngưỡng này sẽ KHÔNG chạy nhánh LIKE chuỗi-con trên `code` —
// token 1 ký tự (vd "4") khớp gần như toàn bộ bảng, khiến mảng id trả về phình
// to và vượt giới hạn bind variable của Postgres (tối đa 32767) khi caller
// dùng `{ in: matchedIds }`. Nhánh `name` theo ranh giới từ vẫn được giữ.
const MIN_LIKE_LEN = 2;

// Chốt chặn cuối: giới hạn số id trả về cho mỗi token, phòng trường hợp DB
// phình to sau này vẫn không bao giờ vượt giới hạn bind variable.
const PER_TOKEN_LIMIT = 5000;

/**
 * Tìm id sản phẩm khớp từ khóa `search` theo quy tắc khớp-từ-trọn-vẹn.
 * Trả về mảng id (rỗng nếu chuỗi rỗng hoặc không khớp gì).
 */
export async function searchProductIds(
  prisma: PrismaService,
  search: string,
): Promise<number[]> {
  // Tách token theo MỌI ký tự không phải chữ/số (Unicode-aware), để dấu câu
  // trong tên (vd "100gr ( 8 túi/thùng)") tự bị loại, không thành token rác
  // phá điều kiện AND.
  const tokens = (search || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return [];

  const tokenSets = await Promise.all(
    tokens.map((t) => {
      const nameCond = Prisma.sql`unaccent(lower(name)) ~ ('\\m' || unaccent(lower(${escapeRegex(
        t,
      )})) || '\\M')`;

      // Chỉ thêm nhánh LIKE chuỗi-con trên `code` khi token đủ dài.
      const where =
        t.length >= MIN_LIKE_LEN
          ? Prisma.sql`${nameCond}
            OR lower(code) LIKE lower(${`%${t}%`})`
          : nameCond;

      return prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "products"
        WHERE (${where})
        LIMIT ${PER_TOKEN_LIMIT}
      `;
    }),
  );

  if (tokenSets.length === 1) return tokenSets[0].map((r) => r.id);

  // Giao các tập id (AND) — sản phẩm phải khớp mọi token.
  const idSets = tokenSets.map((rows) => new Set(rows.map((r) => r.id)));
  return tokenSets[0]
    .filter((r) => idSets.every((s) => s.has(r.id)))
    .map((r) => r.id);
}
