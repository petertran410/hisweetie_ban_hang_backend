/**
 * Trường nhân viên được phép trả về API khi kèm theo chứng từ (người bán,
 * người tạo, người phụ trách...).
 *
 * KHÔNG dùng `include: { soldBy: true }` / `creator: true` cho quan hệ tới
 * `User`: Prisma sẽ trả cả dòng User, gồm mật khẩu đã mã hóa, googleId,
 * larkUserId... ra ngoài. Luôn dùng `{ select: USER_PUBLIC_SELECT }`.
 */
export const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
} as const;

/** Bỏ các trường bí mật khỏi 1 dòng User trước khi trả về API. */
export function stripUserSecrets<T extends { password?: unknown }>(
  user: T,
): Omit<T, 'password'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, ...rest } = user;
  return rest;
}
