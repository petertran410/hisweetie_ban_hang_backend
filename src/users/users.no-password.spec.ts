import { UsersService } from './users.service';

/** API nhân viên không được trả mật khẩu đã mã hóa (GET /users, GET /users/:id). */
describe('UsersService không trả mật khẩu', () => {
  const row = {
    id: 3,
    name: 'NV A',
    email: 'a@x.vn',
    password: '$2b$10$hash',
    branch: null,
    userRoles: [{ role: { id: 1, name: 'Sale', rolePermissions: [] } }],
    userPermissions: [],
    userBranches: [],
    userBranchRoles: [],
  };

  const build = () => {
    const prisma = {
      user: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([row]),
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    return new UsersService(
      prisma as any,
      { create: jest.fn() } as any,
      { invalidateUser: jest.fn() } as any,
    );
  };

  it('danh sách nhân viên', async () => {
    const res = await build().findAll({});
    expect(res.data[0]).toMatchObject({ id: 3, name: 'NV A' });
    expect(res.data[0]).not.toHaveProperty('password');
  });

  it('chi tiết nhân viên', async () => {
    const res = await build().findOne(3);
    expect(res).toMatchObject({ id: 3, name: 'NV A' });
    expect(res).not.toHaveProperty('password');
  });
});
