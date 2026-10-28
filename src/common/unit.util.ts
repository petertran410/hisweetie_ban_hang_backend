import { BadRequestException } from '@nestjs/common';

// ====================================================================
// Đơn vị tính (bảng `units`) — hàm dùng chung cho mọi nơi GHI Product.unit
// (ProductsService.create/update, import Excel, script khởi tạo).
//
// Product.unit vẫn là chuỗi tên; các hàm này bảo đảm tên được ghi luôn là
// tên chuẩn trong bảng: "thùng", " THÙNG " → "Thùng".
// ====================================================================

/** Mã đơn vị hệ thống "Thùng" — logic nhận theo mã, không so chữ. */
export const CARTON_UNIT_CODE = 'CARTON';
export const CARTON_UNIT_NAME = 'Thùng';

/**
 * Khóa so sánh: chuẩn hóa NFC (gộp dấu gõ tách rời), bỏ khoảng trắng thừa,
 * không phân biệt hoa/thường.
 */
export function normalizeUnitKey(value?: string | null): string {
  return (value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Tên hiển thị gọn: NFC + gộp khoảng trắng (giữ nguyên hoa/thường). */
export function cleanUnitName(value?: string | null): string {
  return (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Khóa so sánh → tên chuẩn, gồm cả đơn vị đang ẩn (sản phẩm cũ vẫn dùng). */
export async function loadUnitNameMap(db: any): Promise<Map<string, string>> {
  const units = await db.unit.findMany({ select: { name: true } });
  return new Map(
    units.map((u: { name: string }) => [normalizeUnitKey(u.name), u.name]),
  );
}

/**
 * Đổi đơn vị người dùng gửi lên thành tên chuẩn.
 *  - undefined/null → giữ nguyên (không đụng tới cột).
 *  - chuỗi rỗng → '' (bỏ trống đơn vị).
 *  - không có trong bảng → `unknown` để nơi gọi báo lỗi theo ngữ cảnh.
 */
export function resolveUnitFromMap(
  map: Map<string, string>,
  input: string | null | undefined,
): { name: string | null | undefined; unknown?: string } {
  if (input === undefined || input === null) return { name: input };
  const key = normalizeUnitKey(input);
  if (key === '') return { name: '' };
  const name = map.get(key);
  return name ? { name } : { name: undefined, unknown: cleanUnitName(input) };
}

/** Như resolveUnitFromMap nhưng tự đọc bảng và báo lỗi 400 khi không có. */
export async function resolveUnitName(
  db: any,
  input: string | undefined,
): Promise<string | undefined>;
export async function resolveUnitName(
  db: any,
  input: string | null | undefined,
): Promise<string | null | undefined>;
export async function resolveUnitName(
  db: any,
  input: string | null | undefined,
): Promise<string | null | undefined> {
  if (input === undefined || input === null) return input;
  const result = resolveUnitFromMap(await loadUnitNameMap(db), input);
  if (result.unknown !== undefined) {
    throw new BadRequestException(
      `Đơn vị tính "${result.unknown}" chưa có trong danh mục Đơn vị tính`,
    );
  }
  return result.name;
}
