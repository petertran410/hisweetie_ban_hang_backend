const SUPER_ADMIN_ROLE = 'Super Admin';

/**
 * Check quyền phụ (vd ẩn/hiện giá) trong controller. Dùng quyền đã được
 * PermissionsGuard tính theo chi nhánh (request.effectivePermissions), nên
 * endpoint phải có @RequirePermissions / @RequireAnyPermission.
 */
export function requestHasPermission(req: any, permission: string): boolean {
  const user = req?.user;
  if (user?.roles?.includes(SUPER_ADMIN_ROLE)) return true;
  const permissions: string[] =
    req?.effectivePermissions ?? user?.permissions ?? [];
  return permissions.includes(permission);
}
