// ====================================================================
// NGUỒN CHÂN LÝ DUY NHẤT cho TÌM KIẾM KHÁCH HÀNG theo tên / mã / SĐT.
//
// Cùng nguyên tắc với product-search.util:
// - Trên `name`: token phải khớp NHƯ MỘT TỪ TRỌN VẸN nhờ ranh giới từ
//   `\m...\M` của Postgres regex (vẫn unaccent nên gõ không dấu vẫn ra).
//   Tránh token ngắn khớp nhầm chuỗi con bên trong một từ khác.
// - Trên `code` / `contactNumber` / `phone`: vẫn khớp chuỗi con.
// - Nhiều token → giao (AND): khách hàng phải khớp TẤT CẢ các từ, không
//   phụ thuộc thứ tự gõ.
//
// Dùng chung cho mọi endpoint tìm khách hàng (list, search, export) để
// đảm bảo một hành vi tìm kiếm nhất quán.
// ====================================================================

import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Escape ký tự đặc biệt của POSIX regex để từ khóa người dùng không phá cú
// pháp regex (vd khi gõ có dấu ngoặc).
const escapeRegex = (t: string) => t.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');

// Token ngắn hơn ngưỡng này sẽ KHÔNG chạy nhánh LIKE chuỗi-con trên
// code/contactNumber/phone — vì token 1 ký tự (vd "4", "3") khớp gần như toàn
// bộ bảng, khiến mảng id trả về phình to và vượt giới hạn bind variable của
// Postgres (tối đa 32767) khi caller dùng `{ in: matchedIds }`. Nhánh `name`
// theo ranh giới từ vẫn được giữ vì 1 ký tự gần như không khớp nhầm.
const MIN_LIKE_LEN = 2;

// Chốt chặn cuối: giới hạn số id trả về cho mỗi token, phòng trường hợp DB
// phình to sau này vẫn không bao giờ vượt giới hạn bind variable.
const PER_TOKEN_LIMIT = 5000;

/**
 * Tìm id khách hàng khớp từ khóa `search` theo quy tắc khớp-từ-trọn-vẹn cho
 * tên, chuỗi-con cho mã / số điện thoại.
 * Trả về mảng id (rỗng nếu chuỗi rỗng hoặc không khớp gì).
 */
export async function searchCustomerIds(
  prisma: PrismaService,
  search: string,
): Promise<number[]> {
  const normalized = (search || '').normalize('NFC');
  // Tách token theo MỌI ký tự không phải chữ/số (Unicode-aware), để dấu câu
  // như "-", "(", ")", "," trong tên (vd "Ms Giang - Hoàng Mai, Hà Nội (Sale)")
  // tự bị loại, không trở thành token rác phá điều kiện AND.
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const tokenSets = await Promise.all(
    tokens.map((t) => {
      const nameCond = Prisma.sql`unaccent(lower(name)) ~ ('\\m' || unaccent(lower(${escapeRegex(
        t,
      )})) || '\\M')`;

      // Chỉ thêm nhánh LIKE chuỗi-con khi token đủ dài (>= MIN_LIKE_LEN).
      const where =
        t.length >= MIN_LIKE_LEN
          ? Prisma.sql`${nameCond}
            OR lower(code) LIKE lower(${`%${t}%`})
            OR "contactNumber" LIKE ${`%${t}%`}
            OR phone LIKE ${`%${t}%`}`
          : nameCond;

      return prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "customers"
        WHERE (${where})
        LIMIT ${PER_TOKEN_LIMIT}
      `;
    }),
  );

  if (tokenSets.length === 1) return tokenSets[0].map((r) => r.id);

  // Giao các tập id (AND) — khách hàng phải khớp mọi token.
  const idSets = tokenSets.map((rows) => new Set(rows.map((r) => r.id)));
  return tokenSets[0]
    .filter((r) => idSets.every((s) => s.has(r.id)))
    .map((r) => r.id);
}
