import { ConflictException, NotFoundException } from '@nestjs/common';
import { RecipesService } from './recipes.service';

/**
 * Tests cho vòng đời publish sau khi loại bỏ RecipeVersion.
 *
 * Trọng tâm là quy tắc nghiệp vụ của publish/unpublish/restore/remove —
 * nay chỉ còn dựa trên `Recipe.status` thay vì trạng thái của version.
 *
 * Test hộp đen: dựng mock prisma + auditLogs vừa đủ, không đụng Prisma thật.
 */

type RecipeRow = {
  id: number;
  code: string;
  slug: string;
  name: string;
  type: string;
  status: string;
  publishedAt: Date | null;
  publishedBy: number | null;
  changeNote: string | null;
  description: string | null;
  quantity: any;
  quantityUnit: string | null;
  unit: string | null;
  storage: string | null;
  currencyCode: string;
  costStatus: string;
  materialCost: any;
  semiFinishedCost: any;
  customCost: any;
  totalCost: any;
  costPerOutputUnit: any;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: number | null;
};

const baseRecipe = (overrides: Partial<RecipeRow> = {}): RecipeRow => ({
  id: 1,
  code: 'RCP-001',
  slug: 'tra-sua',
  name: 'Trà sữa',
  type: 'FINISHED_PRODUCT',
  status: 'DRAFT',
  publishedAt: null,
  publishedBy: null,
  changeNote: null,
  description: null,
  quantity: 1000,
  quantityUnit: 'ml',
  unit: 'ly',
  storage: null,
  currencyCode: 'VND',
  costStatus: 'FRESH',
  materialCost: null,
  semiFinishedCost: null,
  customCost: null,
  totalCost: null,
  costPerOutputUnit: null,
  createdBy: 1,
  updatedBy: 1,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
  deletedBy: null,
  ...overrides,
});

function makePrismaMock(initial: {
  recipe: RecipeRow;
  ingredients?: any[];
  steps?: any[];
  images?: any[];
}) {
  const store = { recipe: { ...initial.recipe } };
  const ingredients = initial.ingredients ?? [
    {
      id: 1,
      recipeId: initial.recipe.id,
      sourceType: 'CUSTOM',
      customName: 'Đường',
      customPrice: 10,
      quantity: 2,
      unit: 'gram',
      includeInCost: true,
      productId: null,
      recipeReferenceId: null,
      ingredientId: null,
      customUnit: 'gram',
      unitCostSnapshot: null,
      note: null,
      sortOrder: 0,
    },
  ];

  const hydrate = () => ({
    ...store.recipe,
    category: null,
    outputProduct: null,
    creator: null,
    ingredients,
    steps: initial.steps ?? [],
    images: initial.images ?? [],
  });

  return {
    calls: [] as { method: string; payload?: any }[],
    recipe: {
      findFirst: async (args: any) => {
        const row = store.recipe;
        if (args?.where?.id != null && args.where.id !== row.id) return null;
        if (args?.where?.deletedAt === null && row.deletedAt !== null)
          return null;
        return args?.include ? hydrate() : { ...row };
      },
      findUnique: async () => ({ ...store.recipe }),
      update: async (args: any) => {
        Object.assign(store.recipe, args.data);
        return { ...store.recipe };
      },
    },
    recipeIngredient: {
      count: async () => 0,
      findMany: async () => ingredients,
    },
    priceBook: { findFirst: async () => null },
    priceBookDetail: { findMany: async () => [] },
    user: { findUnique: async () => ({ name: 'Test User' }) },
    __store: store,
  } as any;
}

const auditLogsMock = { create: jest.fn().mockResolvedValue(undefined) };

const makeService = (prisma: any) =>
  new RecipesService(prisma, auditLogsMock as any);

describe('RecipesService — vòng đời publish (không còn version)', () => {
  beforeEach(() => auditLogsMock.create.mockClear());

  describe('publish', () => {
    it('chuyển recipe DRAFT sang PUBLISHED và ghi publishedAt', async () => {
      const prisma = makePrismaMock({ recipe: baseRecipe() });
      const service = makeService(prisma);

      await service.publish(1, {}, 1);

      expect(prisma.__store.recipe.status).toBe('PUBLISHED');
      expect(prisma.__store.recipe.publishedAt).toBeInstanceOf(Date);
      expect(prisma.__store.recipe.publishedBy).toBe(1);
    });

    it('từ chối publish công thức không có nguyên liệu', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe(),
        ingredients: [],
      });
      const service = makeService(prisma);

      await expect(service.publish(1, {}, 1)).rejects.toThrow(
        'Công thức phải có ít nhất một nguyên liệu',
      );
    });

    it('từ chối publish công thức đã lưu trữ', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'ARCHIVED' }),
      });
      const service = makeService(prisma);

      await expect(service.publish(1, {}, 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('lưu changeNote khi được truyền vào', async () => {
      const prisma = makePrismaMock({ recipe: baseRecipe() });
      const service = makeService(prisma);

      await service.publish(1, { changeNote: 'Cập nhật tỷ lệ đường' }, 1);

      expect(prisma.__store.recipe.changeNote).toBe('Cập nhật tỷ lệ đường');
    });
  });

  describe('unpublish', () => {
    it('chuyển recipe PUBLISHED về DRAFT và xóa publishedAt', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({
          status: 'PUBLISHED',
          publishedAt: new Date('2026-02-01'),
          publishedBy: 1,
        }),
      });
      const service = makeService(prisma);

      await service.unpublish(1, 1);

      expect(prisma.__store.recipe.status).toBe('DRAFT');
      expect(prisma.__store.recipe.publishedAt).toBeNull();
      expect(prisma.__store.recipe.publishedBy).toBeNull();
    });

    it('báo lỗi khi công thức không tồn tại', async () => {
      const prisma = makePrismaMock({ recipe: baseRecipe() });
      const service = makeService(prisma);

      await expect(service.unpublish(999, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('từ chối unpublish công thức đã lưu trữ', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'ARCHIVED' }),
      });
      const service = makeService(prisma);

      await expect(service.unpublish(1, 1)).rejects.toThrow(
        'Công thức đã lưu trữ, không thể bỏ publish',
      );
    });

    it('từ chối unpublish công thức chưa publish', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'DRAFT' }),
      });
      const service = makeService(prisma);

      await expect(service.unpublish(1, 1)).rejects.toThrow(
        'Công thức chưa publish, không thể bỏ publish',
      );
    });
  });

  /**
   * Hồi quy cho bug gốc: trước đây unpublish giữ version ở trạng thái
   * PUBLISHED nên publish lại bị chặn bởi "Chỉ draft version mới được publish".
   */
  describe('hồi quy: publish → unpublish → publish lại', () => {
    it('publish lại được ngay sau khi unpublish, không cần sửa gì', async () => {
      const prisma = makePrismaMock({ recipe: baseRecipe() });
      const service = makeService(prisma);

      await service.publish(1, {}, 1);
      expect(prisma.__store.recipe.status).toBe('PUBLISHED');

      await service.unpublish(1, 1);
      expect(prisma.__store.recipe.status).toBe('DRAFT');

      await expect(service.publish(1, {}, 1)).resolves.toBeDefined();
      expect(prisma.__store.recipe.status).toBe('PUBLISHED');
      expect(prisma.__store.recipe.publishedAt).toBeInstanceOf(Date);
    });
  });

  describe('restore', () => {
    it('khôi phục về PUBLISHED nếu trước đó đã từng publish', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({
          status: 'ARCHIVED',
          publishedAt: new Date('2026-02-01'),
        }),
      });
      const service = makeService(prisma);

      await service.restore(1, 1);

      expect(prisma.__store.recipe.status).toBe('PUBLISHED');
    });

    it('khôi phục về DRAFT nếu chưa từng publish', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'ARCHIVED', publishedAt: null }),
      });
      const service = makeService(prisma);

      await service.restore(1, 1);

      expect(prisma.__store.recipe.status).toBe('DRAFT');
    });
  });

  describe('remove', () => {
    it('từ chối xóa công thức đang PUBLISHED', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'PUBLISHED' }),
      });
      const service = makeService(prisma);

      await expect(service.remove(1, 1)).rejects.toThrow(
        'Công thức đã publish chỉ có thể lưu trữ',
      );
    });

    it('cho phép xóa mềm công thức DRAFT', async () => {
      const prisma = makePrismaMock({
        recipe: baseRecipe({ status: 'DRAFT' }),
      });
      const service = makeService(prisma);

      await expect(service.remove(1, 1)).resolves.toEqual({ success: true });
      expect(prisma.__store.recipe.deletedAt).toBeInstanceOf(Date);
    });
  });
});
