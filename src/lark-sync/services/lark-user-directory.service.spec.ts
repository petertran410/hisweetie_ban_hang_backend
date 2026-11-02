import { LarkUserDirectoryService } from './lark-user-directory.service';

describe('LarkUserDirectoryService.openIdsInDepartments', () => {
  const names: Record<string, string> = {
    d_sales: 'Bộ Phận Sales',
    d_kho: 'Kho Hà Nội',
  };
  const children: Record<
    string,
    { open_department_id: string; name: string }[]
  > = {
    d_sales: [{ open_department_id: 'd_kd1', name: 'Phòng Kinh Doanh 1' }],
    d_kho: [],
  };
  const members: Record<string, string[]> = {
    d_sales: ['ou_a'],
    d_kd1: ['ou_a', 'ou_b', 'ou_c'],
    d_kho: ['ou_k'],
  };
  const client = {
    contact: {
      scope: {
        list: jest.fn(async () => ({
          data: { department_ids: ['d_sales', 'd_kho'] },
        })),
      },
      department: {
        get: jest.fn(async ({ path }) => ({
          data: { department: { name: names[path.department_id] } },
        })),
        children: jest.fn(async ({ path }) => ({
          data: { items: children[path.department_id] },
        })),
      },
      user: {
        findByDepartment: jest.fn(async ({ params }) => ({
          data: {
            items: members[params.department_id].map((open_id) => ({
              open_id,
            })),
          },
        })),
      },
    },
  };
  const service = new LarkUserDirectoryService(client as any);

  it('gồm thành viên phòng ban con', async () => {
    expect(
      [...(await service.openIdsInDepartments(['Bộ Phận Sales']))].sort(),
    ).toEqual(['ou_a', 'ou_b', 'ou_c']);
    expect([...(await service.openIdsInDepartments(['Kho Hà Nội']))]).toEqual([
      'ou_k',
    ]);
    expect(
      [...(await service.openIdsInDepartments(['Phòng Kinh Doanh 1']))].sort(),
    ).toEqual(['ou_a', 'ou_b', 'ou_c']);
  });
});
