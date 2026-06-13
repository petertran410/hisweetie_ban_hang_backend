/**
 * Lấy phạm vi nhà cung cấp (supplier scope) của user hiện tại từ req.user.
 *
 * - Trả về `supplierId` (number) nếu user là nhân viên phía nhà cung cấp →
 *   dữ liệu phải bị giới hạn theo NCC này.
 * - Trả về `null` nếu user là nhân viên nội bộ → không giới hạn, thấy mọi NCC.
 *
 * QUAN TRỌNG: giá trị này LUÔN lấy từ JWT (server-side), không bao giờ tin
 * tham số supplierId do client gửi lên.
 */
export function getSupplierScope(req: any): number | null {
  const supplierId = req?.user?.supplierId;
  return typeof supplierId === 'number' && supplierId > 0 ? supplierId : null;
}
