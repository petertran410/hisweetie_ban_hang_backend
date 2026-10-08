/**
 * Multer đọc tên file UTF-8 như Latin-1, nên "Bột" bị lưu thành "BoÌ£Ìt".
 * Chỉ sửa khi chuỗi còn nằm trong 1 byte và giải mã lại ra UTF-8 hợp lệ.
 */
export function repairUploadedFilename(value: string): string {
  if (!value) return value;

  const characters = Array.from(value);
  if (characters.some((char) => char.charCodeAt(0) > 0xff)) return value;
  if (!characters.some((char) => char.charCodeAt(0) > 0x7f)) return value;

  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) return value;

  return Buffer.from(decoded, 'utf8').toString('latin1') === value
    ? decoded
    : value;
}
