// ====================================================================
// Helper tập trung cho InventoryLog — đảm bảo MỌI điểm ghi log tồn kho
// đều lưu được người thực hiện (userId + createdByName) để truy vết trách
// nhiệm trên thẻ kho.
//
// Trước đây InventoryLog chỉ có createdByName (String?) và phần lớn các điểm
// ghi KHÔNG set field này → không thể biết ai đã xuất/nhập kho. Từ nay schema
// có thêm userId (Int? + relation User) và helper này chuẩn hóa cách truyền
// thông tin người thực hiện vào mọi inventoryLog.create.
//
// Cách dùng: service fetch user 1 lần ở method public, truyền { userId,
// userName } xuống các private method ghi log, rồi spread kết quả của helper
// vào data của inventoryLog.create:
//
//   const actor = buildInventoryLogActor(userId, user?.name);
//   await tx.inventoryLog.create({
//     data: {
//       ... các field nghiệp vụ ...,
//       ...buildInventoryLogBase(actor),
//     },
//   });
// ====================================================================

export interface InventoryLogActor {
  /** ID người thực hiện (từ CurrentUser). Null cho log do hệ thống sinh. */
  userId?: number | null;
  /** Tên hiển thị của người thực hiện (snapshot, không đổi khi user đổi tên). */
  userName?: string | null;
}

/**
 * Trả về object { userId, createdByName } sẵn để spread vào `data` của
 * `inventoryLog.create`. Chuẩn hóa: userId null/0 → undefined (không ghi),
 * createdByName rỗng → undefined.
 */
export function buildInventoryLogBase(
  actor: InventoryLogActor | null | undefined,
): { userId?: number; createdByName?: string } {
  if (!actor) return {};
  const userId =
    actor.userId != null && actor.userId !== 0 ? actor.userId : undefined;
  const createdByName =
    actor.userName != null && String(actor.userName).trim() !== ''
      ? String(actor.userName).trim()
      : undefined;
  const base: { userId?: number; createdByName?: string } = {};
  if (userId !== undefined) base.userId = userId;
  if (createdByName !== undefined) base.createdByName = createdByName;
  return base;
}

/**
 * Helper tiện lợi: gói (userId, userName) thô thành InventoryLogActor.
 * Dùng khi service chỉ có 2 giá trị rời rạc thay vì object.
 */
export function buildInventoryLogActor(
  userId?: number | null,
  userName?: string | null,
): InventoryLogActor {
  return { userId: userId ?? undefined, userName: userName ?? undefined };
}
