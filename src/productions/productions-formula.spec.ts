import { BadRequestException } from '@nestjs/common';
import { ProductionsService } from './productions.service';

describe('ProductionsService — chọn công thức', () => {
  const makeService = (product: any) => {
    const findUnique = jest.fn().mockResolvedValue(product);
    const prisma = {
      product: { findUnique },
      inventory: {
        findUnique: jest.fn().mockResolvedValue({ cost: 1000 }),
      },
    };
    const service = new ProductionsService(prisma as any, {} as any) as any;
    return { service, findUnique, prisma };
  };

  it('có formulaId → chỉ nạp thành phần của công thức đó', async () => {
    const { service, findUnique, prisma } = makeService({
      id: 1,
      comboComponents: [],
      formulas: [{ id: 7, name: 'Công thức 2' }],
    });

    const { formula } = await service.loadProductWithFormula(prisma, 1, 7);

    expect(formula).toEqual({ id: 7, name: 'Công thức 2' });
    const include = findUnique.mock.calls[0][0].include;
    expect(include.comboComponents.where).toEqual({ formulaId: 7 });
    expect(include.formulas.where).toEqual({ id: 7 });
  });

  it('không có formulaId → công thức mặc định', async () => {
    const { service, findUnique, prisma } = makeService({
      id: 1,
      comboComponents: [],
      formulas: [{ id: 3, name: 'Công thức 1' }],
    });

    await service.loadProductWithFormula(prisma, 1, undefined);

    const include = findUnique.mock.calls[0][0].include;
    expect(include.comboComponents.where).toEqual({
      OR: [{ formulaId: null }, { formula: { isDefault: true } }],
    });
    expect(include.formulas.where).toEqual({ isDefault: true });
  });

  it('formulaId không thuộc sản phẩm → báo lỗi', async () => {
    const { service, prisma } = makeService({
      id: 1,
      comboComponents: [],
      formulas: [],
    });
    await expect(
      service.loadProductWithFormula(prisma, 1, 99),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('totalCost tính theo thành phần của công thức đã chọn', async () => {
    const { service } = makeService(null);
    const cost = await service.calculateTotalCost(
      [{ componentProductId: 5, quantity: 2, inputMode: 'piece' }],
      1,
      10,
    );
    expect(cost).toBe(1000 * 2 * 10);
  });
});
