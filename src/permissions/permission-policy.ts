const RETIRED_PERMISSION_NAMES = new Set(['orders:delete']);

export function isRetiredPermissionName(name: string): boolean {
  return RETIRED_PERMISSION_NAMES.has(name);
}
