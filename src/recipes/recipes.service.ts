import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { searchProductIds } from '../common/product-search.util';
import { searchRecipeIds } from '../common/recipe-search.util';
import { slugifyVietnamese } from '../common/slug.util';
import {
  CalculateCostDto,
  CloneRecipeDto,
  CreateRecipeCategoryDto,
  CreateRecipeCommentDto,
  CreateRecipeDto,
  CreateRecipeIngredientDto,
  CreateRecipeMediaDto,
  CreateRecipeStepDto,
  PublishRecipeDto,
  RecipeQueryDto,
  UpdateRecipeDto,
  UpdateRecipeCommentDto,
} from './dto';

const RECIPE_INCLUDE = {
  category: true,
  outputProduct: {
    select: { id: true, code: true, name: true, unit: true, basePrice: true },
  },
  creator: { select: { id: true, name: true } },
} as const;

const CONTENT_INCLUDE = {
  ingredients: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          conversionValue: true,
          basePrice: true,
          weight: true,
          weightUnit: true,
        },
      },
      recipeReference: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
          status: true,
          costPerOutputUnit: true,
        },
      },
      ingredient: true,
    },
  },
  steps: { orderBy: { sortOrder: 'asc' as const } },
  images: { orderBy: { sortOrder: 'asc' as const } },
} as const;

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(query: RecipeQueryDto, includeCost = false) {
    const page = Math.max(query.page || 1, 1);
    const limit = Math.min(Math.max(query.limit || 15, 1), 100);
    const where: any = { deletedAt: null };

    if (query.search?.trim()) {
      const matchedIds = await searchRecipeIds(
        this.prisma,
        query.search.trim(),
      );
      where.id = { in: matchedIds.length ? matchedIds : [-1] };
    }
    if (query.ingredientFilters?.length) {
      const ingredientWhere = query.ingredientFilters.reduce<
        Prisma.RecipeIngredientWhereInput[]
      >((result, value) => {
        const separator = value.indexOf(':');
        if (separator < 1) return result;
        const sourceType = value.slice(0, separator);
        const rawValue = value.slice(separator + 1);
        const id = Number(rawValue);
        if (sourceType === 'PRODUCT' && Number.isInteger(id))
          result.push({ productId: id });
        if (sourceType === 'SEMI_FINISHED' && Number.isInteger(id))
          result.push({ recipeReferenceId: id });
        if (sourceType === 'CUSTOM' && rawValue) {
          result.push({
            customName: { equals: rawValue, mode: 'insensitive' },
          });
        }
        return result;
      }, []);
      where.ingredients = ingredientWhere.length
        ? { some: { OR: ingredientWhere } }
        : { some: { id: -1 } };
    }
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;

    const orderField = query.orderBy || 'updatedAt';
    const orderDirection = query.orderDirection || 'desc';
    const orderBy =
      orderField === 'totalCost'
        ? { updatedAt: orderDirection }
        : { [orderField]: orderDirection };

    const [rows, total, priceBook] = await Promise.all([
      this.prisma.recipe.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          ...RECIPE_INCLUDE,
          images: {
            where: { mediaType: 'IMAGE' },
            take: 1,
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              mediaType: true,
              fileUrl: true,
              fileName: true,
              altText: true,
              sortOrder: true,
            },
          },
          ingredients: {
            select: {
              sourceType: true,
              productId: true,
              customPrice: true,
              quantity: true,
              includeInCost: true,
              unitCostSnapshot: true,
              product: { select: { weight: true, weightUnit: true } },
              recipeReference: { select: { costPerOutputUnit: true } },
            },
          },
          _count: { select: { referencedByIngredients: true } },
        },
      }),
      this.prisma.recipe.count({ where }),
      includeCost
        ? this.prisma.priceBook.findFirst({
            where: {
              name: { equals: 'Bảng Giá Lẻ HCM', mode: 'insensitive' },
              isActive: true,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const productIds = rows.flatMap((row) =>
      row.ingredients.flatMap((ingredient) =>
        ingredient.sourceType === 'PRODUCT' && ingredient.productId
          ? [ingredient.productId]
          : [],
      ),
    );
    const prices = priceBook
      ? await this.prisma.priceBookDetail.findMany({
          where: {
            priceBookId: priceBook.id,
            productId: { in: productIds },
            isActive: true,
          },
          select: { productId: true, price: true },
        })
      : [];
    const priceMap = new Map(
      prices.map((price) => [price.productId, Number(price.price)]),
    );

    return {
      data: rows.map((row) => {
        const liveTotalCost = row.ingredients.reduce((total, ingredient) => {
          if (!ingredient.includeInCost) return total;
          const quantity = Number(ingredient.quantity);
          if (ingredient.sourceType === 'CUSTOM') {
            return total + Number(ingredient.customPrice || 0) * quantity;
          }
          if (ingredient.sourceType === 'SEMI_FINISHED') {
            const unitCost =
              ingredient.unitCostSnapshot ??
              ingredient.recipeReference?.costPerOutputUnit;
            return total + Number(unitCost || 0) * quantity;
          }
          const retailPrice = ingredient.productId
            ? priceMap.get(ingredient.productId)
            : undefined;
          const netWeightGram = this.toGram(
            ingredient.product?.weight,
            ingredient.product?.weightUnit,
          );
          return retailPrice != null && netWeightGram != null
            ? total + (retailPrice / netWeightGram) * quantity
            : total;
        }, 0);
        const { ingredients, images, ...recipe } = row;
        return {
          ...this.withVisibleCosts({ ...recipe, liveTotalCost }, includeCost),
          thumbnail: images[0] || null,
        };
      }),
      total,
      page,
      limit,
    };
  }

  async getIngredientOptions() {
    const rows = await this.prisma.recipeIngredient.findMany({
      where: { recipe: { deletedAt: null } },
      include: {
        product: { select: { id: true, code: true, name: true } },
        recipeReference: { select: { id: true, code: true, name: true } },
        ingredient: { select: { id: true, code: true, name: true } },
      },
    });
    const options = new Map<
      string,
      { value: string; label: string; group: string }
    >();
    for (const row of rows) {
      if (row.sourceType === 'PRODUCT' && row.product) {
        options.set(`PRODUCT:${row.product.id}`, {
          value: `PRODUCT:${row.product.id}`,
          label: `${row.product.code} - ${row.product.name}`,
          group: 'Sản phẩm',
        });
      } else if (row.sourceType === 'SEMI_FINISHED' && row.recipeReference) {
        options.set(`SEMI_FINISHED:${row.recipeReference.id}`, {
          value: `SEMI_FINISHED:${row.recipeReference.id}`,
          label: `${row.recipeReference.code} - ${row.recipeReference.name}`,
          group: 'Bán thành phẩm',
        });
      } else if (row.sourceType === 'CUSTOM' && row.customName?.trim()) {
        const name = row.customName.trim();
        const key = `CUSTOM:${name.toLocaleLowerCase('vi')}`;
        options.set(key, {
          value: `CUSTOM:${name}`,
          label: row.ingredient?.code
            ? `${row.ingredient.code} - ${name}`
            : name,
          group: 'Nguyên liệu ngoài',
        });
      }
    }
    const groupOrder = ['Sản phẩm', 'Bán thành phẩm', 'Nguyên liệu ngoài'];
    return [...options.values()].sort(
      (a, b) =>
        groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
        a.label.localeCompare(b.label, 'vi'),
    );
  }

  async getIngredientProducts(search?: string, includeCost = false) {
    const priceBook = await this.prisma.priceBook.findFirst({
      where: {
        name: { equals: 'Bảng Giá Lẻ HCM', mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true },
    });
    const matchedIds = search?.trim()
      ? await searchProductIds(this.prisma, search.trim())
      : undefined;
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        parentName: {
          in: ['Hàng thương mại', 'Hàng thương hiệu'],
        },
        ...(matchedIds
          ? { id: { in: matchedIds.length ? matchedIds : [-1] } }
          : {}),
      },
      take: 50,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        unit: true,
        weight: true,
        weightUnit: true,
        priceBookDetails: priceBook
          ? {
              where: { priceBookId: priceBook.id, isActive: true },
              take: 1,
              select: { price: true },
            }
          : false,
      },
    });
    return products.map((product) => {
      const retailPrice = product.priceBookDetails?.[0]
        ? Number(product.priceBookDetails[0].price)
        : null;
      const netWeightGram = this.toGram(product.weight, product.weightUnit);
      return {
        id: product.id,
        code: product.code,
        name: product.name,
        unit: product.unit,
        weight: product.weight == null ? null : Number(product.weight),
        weightUnit: product.weightUnit,
        retailPrice: includeCost ? retailPrice : undefined,
        netWeightGram,
        unitCost:
          includeCost && retailPrice != null && netWeightGram != null
            ? retailPrice / netWeightGram
            : undefined,
      };
    });
  }

  async getSemiFinishedOptions(search?: string, excludeId?: number) {
    const matchedIds = search?.trim()
      ? await searchRecipeIds(this.prisma, search.trim())
      : undefined;
    return this.prisma.recipe.findMany({
      where: {
        deletedAt: null,
        type: 'SEMI_FINISHED',
        status: 'PUBLISHED',
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(matchedIds
          ? { id: { in: matchedIds.length ? matchedIds : [-1] } }
          : {}),
      },
      take: 50,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
      },
    });
  }

  async findOne(id: number, includeCost = false) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id, deletedAt: null },
      include: { ...RECIPE_INCLUDE, ...CONTENT_INCLUDE },
    });
    if (!recipe) throw new NotFoundException('Không tìm thấy công thức');

    const withCosts = await this.attachIngredientUnitCosts(recipe);
    return this.withVisibleCosts(withCosts, includeCost);
  }

  async create(dto: CreateRecipeDto, userId: number) {
    const name = dto.name.trim();
    if (!name)
      throw new BadRequestException('Tên công thức không được để trống');
    const code = await this.resolveCode(dto.code);
    const slug = await this.resolveSlug(name);
    await this.validateSources(undefined, dto.ingredients || []);

    const result = await this.prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: {
          code,
          slug,
          name,
          type: dto.type,
          categoryId: dto.categoryId || null,
          outputProductId: dto.outputProductId || null,
          description: dto.description?.trim() || null,
          quantity: dto.quantity ?? null,
          quantityUnit: dto.quantityUnit || null,
          unit: dto.unit?.trim() || null,
          storage: dto.storage?.trim() || null,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      await this.validateSources(recipe.id, dto.ingredients || []);
      await tx.recipe.update({
        where: { id: recipe.id },
        data: {
          ingredients: { create: this.mapIngredients(dto.ingredients || []) },
          steps: { create: this.mapSteps(dto.steps || []) },
          images: { create: this.mapMedia(dto.media || []) },
        },
      });
      return recipe;
    });

    await this.rebuildDependencies(result.id);
    await this.calculateCost(result.id, {}, userId);
    await this.writeAudit('CREATE', result, userId);
    return this.findOne(result.id);
  }

  async update(id: number, dto: UpdateRecipeDto, userId: number) {
    const current = await this.findOne(id);
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('Không thể sửa công thức đã lưu trữ');
    }
    if (dto.ingredients) await this.validateSources(id, dto.ingredients);

    const recipeData: any = { updatedBy: userId, costStatus: 'STALE' };
    for (const key of [
      'name',
      'type',
      'description',
      'quantity',
      'quantityUnit',
      'unit',
      'storage',
    ] as const) {
      if (dto[key] !== undefined) recipeData[key] = dto[key];
    }
    if (dto.categoryId !== undefined) recipeData.categoryId = dto.categoryId;
    if (dto.outputProductId !== undefined)
      recipeData.outputProductId = dto.outputProductId;
    if (dto.changeNote !== undefined) recipeData.changeNote = dto.changeNote;

    await this.prisma.$transaction(async (tx) => {
      await tx.recipe.update({ where: { id }, data: recipeData });

      if (dto.ingredients) {
        const existingIngredients = await tx.recipeIngredient.findMany({
          where: { recipeId: id },
        });
        await tx.recipeIngredient.deleteMany({ where: { recipeId: id } });
        if (dto.ingredients.length) {
          const mappedRows = this.mapIngredients(dto.ingredients);
          const referenceIds = mappedRows
            .filter((row) => row.sourceType === 'SEMI_FINISHED')
            .map((row) => row.recipeReferenceId)
            .filter((value): value is number => !!value);
          const references = referenceIds.length
            ? await tx.recipe.findMany({
                where: { id: { in: referenceIds } },
                select: { id: true, costPerOutputUnit: true },
              })
            : [];
          const referenceCostMap = new Map(
            references.map((row) => [
              row.id,
              row.costPerOutputUnit == null
                ? null
                : Number(row.costPerOutputUnit),
            ]),
          );
          const ingredientRows = mappedRows.map((row) => {
            const previous = existingIngredients.find((item) =>
              this.isSameIngredientSource(item, row),
            );
            const fallbackCost =
              row.sourceType === 'SEMI_FINISHED' && row.recipeReferenceId
                ? referenceCostMap.get(row.recipeReferenceId)
                : undefined;
            const unitCost = previous?.unitCostSnapshot ?? fallbackCost;
            const quantity = Number(row.quantity);
            return {
              ...row,
              recipeId: id,
              unitCostSnapshot: unitCost ?? undefined,
              costSnapshot:
                unitCost == null ? undefined : Number(unitCost) * quantity,
              priceSourceSnapshot: previous?.priceSourceSnapshot ?? undefined,
            };
          });
          await tx.recipeIngredient.createMany({ data: ingredientRows });
        }
      }
      if (dto.steps) {
        await tx.recipeStep.deleteMany({ where: { recipeId: id } });
        if (dto.steps.length) {
          await tx.recipeStep.createMany({
            data: this.mapSteps(dto.steps).map((row) => ({
              ...row,
              recipeId: id,
            })),
          });
        }
      }
      if (dto.media) {
        await tx.recipeImage.deleteMany({ where: { recipeId: id } });
        if (dto.media.length) {
          await tx.recipeImage.createMany({
            data: this.mapMedia(dto.media).map((row) => ({
              ...row,
              recipeId: id,
            })),
          });
        }
      }
    });

    if (dto.ingredients) await this.rebuildDependencies(id);
    await this.writeAudit(
      'UPDATE',
      { id, code: current.code, name: dto.name || current.name },
      userId,
    );
    return this.findOne(id);
  }

  /**
   * Công khai công thức lên trang khách hàng (`/cong-thuc`).
   * Điều kiện hiển thị public chỉ còn: `status === 'PUBLISHED'` và có slug.
   */
  async publish(id: number, dto: PublishRecipeDto, userId: number) {
    const recipe = await this.findOne(id);
    if (recipe.status === 'ARCHIVED') {
      throw new ConflictException('Công thức đã lưu trữ, không thể publish');
    }
    if (!recipe.ingredients.length) {
      throw new BadRequestException(
        'Công thức phải có ít nhất một nguyên liệu',
      );
    }

    await this.calculateCost(id, {}, userId, true);
    const now = new Date();

    await this.prisma.recipe.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        changeNote: dto.changeNote || recipe.changeNote || null,
        publishedAt: now,
        publishedBy: userId,
        updatedBy: userId,
      },
    });

    await this.writeAudit('PUBLISH', recipe, userId);
    return this.findOne(id);
  }

  /**
   * Gỡ công thức khỏi trang công khai: chuyển về DRAFT.
   * Nội dung giữ nguyên nên có thể publish lại bất cứ lúc nào.
   */
  async unpublish(id: number, userId: number) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!recipe) throw new NotFoundException('Không tìm thấy công thức');
    if (recipe.status === 'ARCHIVED') {
      throw new ConflictException('Công thức đã lưu trữ, không thể bỏ publish');
    }
    if (recipe.status !== 'PUBLISHED') {
      throw new ConflictException(
        'Công thức chưa publish, không thể bỏ publish',
      );
    }

    await this.prisma.recipe.update({
      where: { id },
      data: {
        status: 'DRAFT',
        publishedAt: null,
        publishedBy: null,
        updatedBy: userId,
      },
    });

    await this.writeAudit('UNPUBLISH', recipe, userId);
    return this.findOne(id);
  }

  async archive(id: number, userId: number) {
    const recipe = await this.findOne(id);
    await this.prisma.recipe.update({
      where: { id },
      data: { status: 'ARCHIVED', updatedBy: userId },
    });
    await this.writeAudit('ARCHIVE', recipe, userId);
    return this.findOne(id);
  }

  async restore(id: number, userId: number) {
    const recipe = await this.findOne(id);
    const status = recipe.publishedAt ? 'PUBLISHED' : 'DRAFT';
    await this.prisma.recipe.update({
      where: { id },
      data: { status, updatedBy: userId },
    });
    await this.writeAudit('RESTORE', recipe, userId);
    return this.findOne(id);
  }

  async remove(id: number, userId: number) {
    const recipe = await this.findOne(id);
    if (recipe.status === 'PUBLISHED') {
      throw new ConflictException('Công thức đã publish chỉ có thể lưu trữ');
    }
    const references = await this.prisma.recipeIngredient.count({
      where: { recipeReferenceId: id },
    });
    if (references)
      throw new ConflictException('Công thức đang được công thức khác sử dụng');

    await this.prisma.recipe.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: userId },
    });
    await this.writeAudit('DELETE', recipe, userId);
    return { success: true };
  }

  async clone(id: number, dto: CloneRecipeDto, userId: number) {
    const source = await this.findOne(id);
    const code = await this.resolveCode(dto.code);
    return this.create(
      {
        code,
        name: dto.name?.trim() || `${source.name} (Bản sao)`,
        type: source.type,
        categoryId: source.categoryId || undefined,
        outputProductId: source.outputProductId || undefined,
        description: source.description || undefined,
        quantity: source.quantity ? Number(source.quantity) : undefined,
        quantityUnit: source.quantityUnit || undefined,
        unit: source.unit || undefined,
        storage: source.storage || undefined,
        ingredients: (source.ingredients || []).map((row: any) => ({
          sourceType: row.sourceType,
          productId: row.productId || undefined,
          recipeReferenceId: row.recipeReferenceId || undefined,
          ingredientId: row.ingredientId || undefined,
          customName: row.customName || undefined,
          customUnit: row.customUnit || undefined,
          customPrice: row.customPrice ? Number(row.customPrice) : undefined,
          quantity: Number(row.quantity),
          unit: row.unit || undefined,
          includeInCost: row.includeInCost,
          isInternal: row.isInternal,
          isTemporary: row.isTemporary,
          note: row.note || undefined,
          sortOrder: row.sortOrder,
        })),
        steps: (source.steps || []).map((row: any) => ({
          title: row.title || undefined,
          content: row.content,
          tools: row.tools || undefined,
          notes: row.notes || undefined,
          sortOrder: row.sortOrder,
        })),
        media: (source.images || []).map((row: any) => ({
          mediaType: row.mediaType,
          fileUrl: row.fileUrl,
          fileName: row.fileName || undefined,
          mimeType: row.mimeType || undefined,
          altText: row.altText || undefined,
          sortOrder: row.sortOrder,
        })),
      } as CreateRecipeDto,
      userId,
    );
  }

  async getCategories() {
    return this.prisma.recipeCategory.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(dto: CreateRecipeCategoryDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên nhóm không được để trống');
    const duplicate = await this.prisma.recipeCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null },
    });
    if (duplicate) throw new ConflictException(`Nhóm "${name}" đã tồn tại`);

    const code = dto.code?.trim().toUpperCase() || null;
    if (code) {
      const duplicateCode = await this.prisma.recipeCategory.findUnique({
        where: { code },
      });
      if (duplicateCode)
        throw new ConflictException(`Mã nhóm "${code}" đã tồn tại`);
    }

    return this.prisma.recipeCategory.create({
      data: { name, code, type: dto.type || null },
    });
  }

  async getComments(recipeId: number) {
    await this.ensureRecipe(recipeId);
    return this.prisma.recipeComment.findMany({
      where: { recipeId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
  }

  async createComment(
    recipeId: number,
    dto: CreateRecipeCommentDto,
    userId: number,
  ) {
    await this.ensureRecipe(recipeId);
    const content = dto.content.trim();
    if (!content)
      throw new BadRequestException('Nội dung bình luận không được để trống');
    return this.prisma.recipeComment.create({
      data: { recipeId, authorId: userId, content },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
  }

  async updateComment(id: number, dto: UpdateRecipeCommentDto, userId: number) {
    const comment = await this.prisma.recipeComment.findUnique({
      where: { id },
    });
    if (!comment) throw new NotFoundException('Không tìm thấy bình luận');
    if (comment.authorId !== userId) {
      throw new ForbiddenException('Bạn chỉ có thể sửa bình luận của mình');
    }
    const content = dto.content.trim();
    if (!content)
      throw new BadRequestException('Nội dung bình luận không được để trống');
    return this.prisma.recipeComment.update({
      where: { id },
      data: { content },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
  }

  async deleteComment(id: number, userId: number) {
    const comment = await this.prisma.recipeComment.findUnique({
      where: { id },
    });
    if (!comment) throw new NotFoundException('Không tìm thấy bình luận');
    if (comment.authorId !== userId) {
      throw new ForbiddenException('Bạn chỉ có thể xóa bình luận của mình');
    }
    await this.prisma.recipeComment.delete({ where: { id } });
    return { success: true };
  }

  async getDependencies(recipeId: number) {
    await this.ensureRecipe(recipeId);
    return this.prisma.recipeDependency.findMany({
      where: { ancestorRecipeId: recipeId },
      orderBy: [{ depth: 'asc' }, { descendant: { name: 'asc' } }],
      include: {
        descendant: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            status: true,
          },
        },
      },
    });
  }

  async calculateCost(
    recipeId: number,
    dto: CalculateCostDto,
    userId: number,
    persist = true,
  ) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id: recipeId, deletedAt: null },
      include: CONTENT_INCLUDE,
    });
    if (!recipe) throw new NotFoundException('Không tìm thấy công thức');

    let priceBookId = dto.priceBookId;
    if (!priceBookId) {
      const defaultBook = await this.prisma.priceBook.findFirst({
        where: {
          name: { equals: 'Bảng Giá Lẻ HCM', mode: 'insensitive' },
          isActive: true,
        },
        select: { id: true },
      });
      priceBookId = defaultBook?.id;
    }

    const productIds = recipe.ingredients
      .filter((row) => row.sourceType === 'PRODUCT' && row.productId)
      .map((row) => row.productId as number);
    const prices = priceBookId
      ? await this.prisma.priceBookDetail.findMany({
          where: { priceBookId, productId: { in: productIds }, isActive: true },
        })
      : [];
    const priceMap = new Map(
      prices.map((row) => [row.productId, Number(row.price)]),
    );

    let materialCost = 0;
    let semiFinishedCost = 0;
    let customCost = 0;
    const breakdown: any[] = [];

    for (const row of recipe.ingredients) {
      const quantity = Number(row.quantity);
      let unitCost = 0;
      let source = 'NONE';

      if (row.sourceType === 'PRODUCT' && row.product) {
        const retailPrice = priceMap.get(row.product.id);
        const netWeightGram = this.toGram(
          row.product.weight,
          row.product.weightUnit,
        );
        if (retailPrice != null && netWeightGram != null) {
          unitCost = retailPrice / netWeightGram;
          source = 'HCM_RETAIL_PRICE_PER_GRAM';
        }
      } else if (row.sourceType === 'SEMI_FINISHED' && row.recipeReferenceId) {
        const reference = await this.prisma.recipe.findUnique({
          where: { id: row.recipeReferenceId },
          select: { costPerOutputUnit: true },
        });
        unitCost = Number(reference?.costPerOutputUnit || 0);
        source = 'SEMI_FINISHED';
      } else if (row.sourceType === 'CUSTOM') {
        unitCost = Number(row.customPrice ?? row.ingredient?.defaultPrice ?? 0);
        source = 'CUSTOM';
      }

      const lineCost = row.includeInCost ? quantity * unitCost : 0;
      if (row.sourceType === 'PRODUCT') materialCost += lineCost;
      if (row.sourceType === 'SEMI_FINISHED') semiFinishedCost += lineCost;
      if (row.sourceType === 'CUSTOM') customCost += lineCost;
      breakdown.push({
        ingredientId: row.id,
        sourceType: row.sourceType,
        name: row.product?.name || row.recipeReference?.name || row.customName,
        quantity,
        unit: row.unit || row.customUnit,
        unitCost,
        lineCost,
        priceSource: source,
      });
    }

    const totalCost = materialCost + semiFinishedCost + customCost;
    const outputQuantity = Number(recipe.quantity || 0);
    const costPerOutputUnit =
      outputQuantity > 0 ? totalCost / outputQuantity : totalCost;
    const result = {
      recipeId: recipe.id,
      priceBookId: priceBookId || null,
      currencyCode: dto.currencyCode || recipe.currencyCode,
      materialCost,
      semiFinishedCost,
      customCost,
      totalCost,
      costPerOutputUnit,
      calculationStatus: 'FRESH',
      breakdown,
    };

    if (persist) {
      await this.prisma.$transaction(async (tx) => {
        await tx.recipe.update({
          where: { id: recipe.id },
          data: {
            materialCost,
            semiFinishedCost,
            customCost,
            totalCost,
            costPerOutputUnit,
            costStatus: 'FRESH',
          },
        });
        for (const item of breakdown) {
          await tx.recipeIngredient.update({
            where: { id: item.ingredientId },
            data: {
              unitCostSnapshot: item.unitCost,
              costSnapshot: item.lineCost,
              priceSourceSnapshot: item.priceSource,
            },
          });
        }
      });
      await this.writeAudit('RECALCULATE', recipe, userId, { totalCost });
    }
    return result;
  }

  private async validateSources(
    recipeId: number | undefined,
    rows: CreateRecipeIngredientDto[],
  ) {
    for (const row of rows) {
      const sourceCount =
        Number(!!row.productId) +
        Number(!!row.recipeReferenceId) +
        Number(!!row.customName);
      if (sourceCount !== 1) {
        throw new BadRequestException('Mỗi nguyên liệu phải có đúng một nguồn');
      }
      if (row.sourceType === 'PRODUCT' && !row.productId) {
        throw new BadRequestException('Nguyên liệu Product phải có productId');
      }
      if (row.sourceType === 'SEMI_FINISHED' && !row.recipeReferenceId) {
        throw new BadRequestException(
          'Bán thành phẩm phải có recipeReferenceId',
        );
      }
      if (row.sourceType === 'CUSTOM' && !row.customName) {
        throw new BadRequestException('Nguyên liệu ngoài phải có tên');
      }
      if (recipeId && row.recipeReferenceId) {
        if (row.recipeReferenceId === recipeId) {
          throw new BadRequestException('Công thức không thể tự tham chiếu');
        }
        if (await this.hasPath(row.recipeReferenceId, recipeId, new Set())) {
          throw new BadRequestException(
            'Không thể thêm bán thành phẩm vì tạo vòng phụ thuộc',
          );
        }
      }
    }
  }

  private async hasPath(
    fromRecipeId: number,
    targetRecipeId: number,
    visited: Set<number>,
  ): Promise<boolean> {
    if (fromRecipeId === targetRecipeId) return true;
    if (visited.has(fromRecipeId)) return false;
    visited.add(fromRecipeId);
    const children = await this.prisma.recipeIngredient.findMany({
      where: { recipeId: fromRecipeId, sourceType: 'SEMI_FINISHED' },
      select: { recipeReferenceId: true },
    });
    for (const child of children) {
      if (
        child.recipeReferenceId &&
        (await this.hasPath(child.recipeReferenceId, targetRecipeId, visited))
      ) {
        return true;
      }
    }
    return false;
  }

  private async rebuildDependencies(recipeId: number) {
    const direct = await this.prisma.recipeIngredient.findMany({
      where: { recipeId, sourceType: 'SEMI_FINISHED' },
      select: { recipeReferenceId: true },
    });
    const depths = new Map<number, number>();
    const queue = direct
      .filter((row) => row.recipeReferenceId)
      .map((row) => ({ id: row.recipeReferenceId as number, depth: 1 }));

    while (queue.length) {
      const item = queue.shift()!;
      const previous = depths.get(item.id);
      if (previous !== undefined && previous <= item.depth) continue;
      depths.set(item.id, item.depth);
      const nested = await this.prisma.recipeIngredient.findMany({
        where: { recipeId: item.id, sourceType: 'SEMI_FINISHED' },
        select: { recipeReferenceId: true },
      });
      for (const row of nested) {
        if (row.recipeReferenceId)
          queue.push({ id: row.recipeReferenceId, depth: item.depth + 1 });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.recipeDependency.deleteMany({
        where: { ancestorRecipeId: recipeId },
      });
      if (depths.size) {
        await tx.recipeDependency.createMany({
          data: Array.from(depths.entries()).map(
            ([descendantRecipeId, depth]) => ({
              ancestorRecipeId: recipeId,
              descendantRecipeId,
              depth,
              isDirect: depth === 1,
            }),
          ),
        });
      }
    });
  }

  private mapIngredients(rows: CreateRecipeIngredientDto[]) {
    return rows.map((row, index) => ({
      sourceType: row.sourceType,
      productId: row.productId || null,
      recipeReferenceId: row.recipeReferenceId || null,
      ingredientId: row.ingredientId || null,
      customName: row.customName?.trim() || null,
      customUnit: row.customUnit || null,
      customPrice: row.customPrice ?? null,
      quantity: row.quantity,
      unit: row.unit || row.customUnit || null,
      includeInCost: row.includeInCost !== false,
      isInternal: row.isInternal || false,
      isTemporary: row.isTemporary || false,
      note: row.note?.trim() || null,
      sortOrder: row.sortOrder ?? index,
    }));
  }

  private mapSteps(rows: CreateRecipeStepDto[]) {
    return rows.map((row, index) => ({
      title: row.title?.trim() || null,
      content: row.content.trim(),
      tools: row.tools || undefined,
      notes: row.notes?.trim() || null,
      sortOrder: row.sortOrder ?? index,
    }));
  }

  private mapMedia(rows: CreateRecipeMediaDto[]) {
    return rows.map((row, index) => ({
      mediaType: row.mediaType,
      fileUrl: row.fileUrl,
      fileName: row.fileName?.trim() || null,
      mimeType: row.mimeType?.trim() || null,
      altText: row.altText?.trim() || null,
      sortOrder: row.sortOrder ?? index,
    }));
  }

  private isSameIngredientSource(previous: any, next: any) {
    if (previous.sourceType !== next.sourceType) return false;
    if (next.sourceType === 'PRODUCT')
      return previous.productId === next.productId;
    if (next.sourceType === 'SEMI_FINISHED') {
      return previous.recipeReferenceId === next.recipeReferenceId;
    }
    return (
      (previous.customName || '').trim().toLowerCase() ===
      (next.customName || '').trim().toLowerCase()
    );
  }

  private async attachIngredientUnitCosts<
    T extends { ingredients: any[] } | null,
  >(recipe: T) {
    if (!recipe) return recipe;
    const productIds = recipe.ingredients
      .filter((row) => row.sourceType === 'PRODUCT' && row.productId)
      .map((row) => row.productId as number);
    const priceBook = productIds.length
      ? await this.prisma.priceBook.findFirst({
          where: {
            name: { equals: 'Bảng Giá Lẻ HCM', mode: 'insensitive' },
            isActive: true,
          },
          select: { id: true },
        })
      : null;
    const details = priceBook
      ? await this.prisma.priceBookDetail.findMany({
          where: {
            priceBookId: priceBook.id,
            productId: { in: productIds },
            isActive: true,
          },
          select: { productId: true, price: true },
        })
      : [];
    const priceMap = new Map(
      details.map((detail) => [detail.productId, Number(detail.price)]),
    );
    return {
      ...recipe,
      ingredients: recipe.ingredients.map((row) => {
        if (row.sourceType !== 'PRODUCT' || !row.product) return row;
        const retailPrice = priceMap.get(row.product.id) ?? null;
        const netWeightGram = this.toGram(
          row.product.weight,
          row.product.weightUnit,
        );
        return {
          ...row,
          product: {
            ...row.product,
            retailPrice,
            netWeightGram,
            unitCost:
              retailPrice != null && netWeightGram != null
                ? retailPrice / netWeightGram
                : null,
          },
        };
      }),
    };
  }

  private withVisibleCosts<T>(recipe: T, includeCost: boolean): T {
    if (!recipe || includeCost || typeof recipe !== 'object') return recipe;
    const visible: any = { ...(recipe as any) };
    delete visible.materialCost;
    delete visible.semiFinishedCost;
    delete visible.customCost;
    delete visible.totalCost;
    delete visible.liveTotalCost;
    delete visible.costPerOutputUnit;
    if (Array.isArray(visible.ingredients)) {
      visible.ingredients = visible.ingredients.map((ingredient: any) => {
        const row = { ...ingredient };
        delete row.customPrice;
        delete row.costSnapshot;
        delete row.unitCostSnapshot;
        delete row.priceSourceSnapshot;
        if (row.recipeReference) {
          row.recipeReference = { ...row.recipeReference };
          delete row.recipeReference.costPerOutputUnit;
        }
        if (row.product) {
          row.product = { ...row.product };
          delete row.product.basePrice;
          delete row.product.retailPrice;
          delete row.product.unitCost;
        }
        return row;
      });
    }
    return visible as T;
  }

  private toGram(weight: unknown, unit?: string | null) {
    const value = Number(weight);
    if (!Number.isFinite(value) || value <= 0) return null;
    const normalizedUnit = unit?.trim().toLowerCase();
    if (normalizedUnit === 'kg') return value * 1000;
    if (normalizedUnit === 'g' || normalizedUnit === 'gram') return value;
    return null;
  }

  private async resolveCode(input?: string) {
    const code = input?.trim().toUpperCase();
    if (code) {
      const duplicate = await this.prisma.recipe.findFirst({
        where: { code, deletedAt: null },
      });
      if (duplicate)
        throw new ConflictException(`Mã công thức "${code}" đã tồn tại`);
      return code;
    }
    let generated = `RCP-${Date.now().toString().slice(-8)}`;
    while (
      await this.prisma.recipe.findUnique({ where: { code: generated } })
    ) {
      generated = `RCP-${Math.floor(Math.random() * 99999999)
        .toString()
        .padStart(8, '0')}`;
    }
    return generated;
  }

  private async resolveSlug(name: string) {
    const base = slugifyVietnamese(name);
    let slug = base;
    let suffix = 2;
    while (await this.prisma.recipe.findUnique({ where: { slug } })) {
      slug = `${base}-${suffix++}`;
    }
    return slug;
  }

  private async ensureRecipe(id: number) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!recipe) throw new NotFoundException('Không tìm thấy công thức');
    return recipe;
  }

  private async writeAudit(
    action: string,
    entity: any,
    userId: number,
    metadata?: any,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    await this.auditLogs.create({
      actionType:
        action === 'CREATE'
          ? 'create'
          : action === 'DELETE'
            ? 'delete'
            : 'update',
      actionCode: `RECIPE_${action}`,
      entityType: 'RECIPE',
      entityId: String(entity.id),
      entityCode: entity.code,
      category: 'Sản phẩm',
      message: `${action} công thức ${entity.code || entity.id}`,
      userId,
      userName: user?.name || `User ${userId}`,
      metadata,
    });
  }
}
