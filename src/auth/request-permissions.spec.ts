import { requestHasPermission } from './request-permissions';

describe('requestHasPermission', () => {
  it('Super Admin luôn có quyền', () => {
    const req = { user: { roles: ['Super Admin'] }, effectivePermissions: [] };
    expect(requestHasPermission(req, 'transfers:view_cost_price')).toBe(true);
  });

  it('ưu tiên quyền theo chi nhánh do PermissionsGuard tính', () => {
    const req = {
      user: { roles: [], permissions: ['transfers:view_cost_price'] },
      effectivePermissions: ['transfers:view'],
    };
    expect(requestHasPermission(req, 'transfers:view_cost_price')).toBe(false);
    expect(requestHasPermission(req, 'transfers:view')).toBe(true);
  });

  it('fallback về user.permissions khi guard chưa tính', () => {
    const req = { user: { permissions: ['transfers:view_cost_price'] } };
    expect(requestHasPermission(req, 'transfers:view_cost_price')).toBe(true);
  });
});
