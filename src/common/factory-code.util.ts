export const FACTORY_CODE_PREFIX = 'NM';

/**
 * Tính mã nhà máy kế tiếp từ danh sách mã đang có: NM0001, NM0002, ...
 *
 * Không dùng `count + 1` vì nhà máy đã xóa sẽ làm mã bị trùng. Chỉ đọc hậu tố
 * số của các mã theo prefix rồi lấy max + 1; mã do người dùng tự đặt (không
 * theo prefix) được bỏ qua.
 */
export function nextFactoryCode(existingCodes: Array<string | null>): string {
  const maxNumber = existingCodes.reduce<number>((max, code) => {
    if (!code?.startsWith(FACTORY_CODE_PREFIX)) return max;
    const suffix = code.slice(FACTORY_CODE_PREFIX.length);
    if (!/^\d+$/.test(suffix)) return max;
    const value = Number(suffix);
    return Number.isSafeInteger(value) ? Math.max(max, value) : max;
  }, 0);
  return formatFactoryCode(maxNumber + 1);
}

export function formatFactoryCode(sequence: number): string {
  return `${FACTORY_CODE_PREFIX}${String(sequence).padStart(4, '0')}`;
}
