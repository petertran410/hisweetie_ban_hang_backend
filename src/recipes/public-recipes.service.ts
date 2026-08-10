import { Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import * as PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { searchRecipeIds } from '../common/recipe-search.util';
import { PublicRecipeQueryDto } from './dto';

const PUBLIC_RECIPE_SELECT = {
  id: true,
  slug: true,
  code: true,
  name: true,
  type: true,
  description: true,
  quantity: true,
  quantityUnit: true,
  unit: true,
  storage: true,
  categoryId: true,
  publishedAt: true,
  category: { select: { id: true, name: true, type: true } },
  ingredients: {
    where: { isInternal: false, isTemporary: false },
    orderBy: { sortOrder: 'asc' as const },
    select: {
      sourceType: true,
      productId: true,
      customName: true,
      customPrice: true,
      customUnit: true,
      quantity: true,
      unit: true,
      includeInCost: true,
      unitCostSnapshot: true,
      note: true,
      sortOrder: true,
      product: { select: { name: true, weight: true, weightUnit: true } },
      recipeReference: { select: { name: true } },
    },
  },
  steps: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      title: true,
      content: true,
      notes: true,
      sortOrder: true,
    },
  },
  images: {
    where: { mediaType: { in: ['IMAGE', 'VIDEO'] as string[] } },
    orderBy: { sortOrder: 'asc' as const },
    select: { mediaType: true, fileUrl: true, altText: true, sortOrder: true },
  },
} satisfies Prisma.RecipeSelect;

type PublicRecipeRow = Awaited<ReturnType<PublicRecipesService['loadPublished']>>[number];

@Injectable()
export class PublicRecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: PublicRecipeQueryDto) {
    const matchedIds = query.search?.trim()
      ? await searchRecipeIds(this.prisma, query.search.trim())
      : undefined;
    const recipes = await this.prisma.recipe.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        slug: { not: null },
        ...(query.type ? { type: query.type } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(matchedIds ? { id: { in: matchedIds.length ? matchedIds : [-1] } } : {}),
      },
      select: PUBLIC_RECIPE_SELECT,
    });
    const rows = await this.loadPublished(recipes);

    rows.sort((a, b) => {
      if (query.sort === 'name') return a.recipe.name.localeCompare(b.recipe.name, 'vi');
      if (query.sort === 'cost') {
        return (a.cost.totalCost ?? Number.POSITIVE_INFINITY) -
          (b.cost.totalCost ?? Number.POSITIVE_INFINITY) ||
          a.recipe.name.localeCompare(b.recipe.name, 'vi');
      }
      return (b.recipe.publishedAt?.getTime() || 0) -
        (a.recipe.publishedAt?.getTime() || 0);
    });

    const page = query.page || 1;
    const limit = Math.min(query.limit || 12, 48);
    const start = (page - 1) * limit;
    const categories = await this.prisma.recipeCategory.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, type: true },
    });

    return {
      data: rows.slice(start, start + limit).map((row) => this.mapSummary(row)),
      total: rows.length,
      page,
      limit,
      categories,
    };
  }

  async findOne(slug: string) {
    const recipe = await this.prisma.recipe.findFirst({
      where: {
        slug,
        status: 'PUBLISHED',
        deletedAt: null,
      },
      select: PUBLIC_RECIPE_SELECT,
    });
    if (!recipe) throw new NotFoundException('Không tìm thấy công thức');

    const [row] = await this.loadPublished([recipe]);
    if (!row) throw new NotFoundException('Không tìm thấy công thức');
    const related = await this.getRelated(row);

    return {
      ...this.mapSummary(row),
      description: row.recipe.description,
      storage: row.recipe.storage,
      ingredients: row.recipe.ingredients.map((ingredient) => ({
        sourceType: ingredient.sourceType,
        name: ingredient.product?.name ||
          ingredient.recipeReference?.name ||
          ingredient.customName || '',
        quantity: Number(ingredient.quantity),
        unit: ingredient.unit || ingredient.customUnit,
        note: ingredient.note,
        sortOrder: ingredient.sortOrder,
        includeInCost: ingredient.includeInCost,
        lineCost: this.lineCost(ingredient, row.priceMap),
      })),
      steps: row.recipe.steps,
      media: row.recipe.images.map((media) => ({
        type: media.mediaType,
        url: media.fileUrl,
        altText: media.altText,
        sortOrder: media.sortOrder,
      })),
      related,
    };
  }

  async generatePdf(slug: string, variant: 'full' | 'guide') {
    const recipe = await this.findOne(slug);
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
      const chunks: Buffer[] = [];
      const sourceFontDir = join(process.cwd(), 'src/contracts/assets/fonts');
      const fontDir = existsSync(sourceFontDir)
        ? sourceFontDir
        : join(__dirname, '../contracts/assets/fonts');
      doc.registerFont('Times', join(fontDir, 'times.ttf'));
      doc.registerFont('Times Bold', join(fontDir, 'times-bold.ttf'));
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const heading = (text: string) => {
        doc.moveDown().font('Times Bold').fontSize(14).text(text).moveDown(0.35);
      };
      doc.font('Times Bold').fontSize(22).text(recipe.name, { align: 'center' });
      doc.moveDown().font('Times').fontSize(11);
      doc.text(`Mã công thức: ${recipe.code}`);
      doc.text(`Loại: ${recipe.type}`);
      if (recipe.category) doc.text(`Danh mục: ${recipe.category.name}`);
      doc.text(`Sản lượng: ${recipe.yield.label}`);
      if (recipe.description) doc.moveDown(0.5).text(recipe.description);

      if (variant === 'full') {
        heading('Chi phí');
        doc.text(`Tổng chi phí: ${this.money(recipe.totalCost)}`);
        doc.text(`Chi phí / đơn vị đầu ra: ${this.money(recipe.costPerOutputUnit)}`);
      }

      heading('Nguyên liệu');
      recipe.ingredients.forEach((ingredient, index) => {
        const cost = variant === 'full' ? ` - ${this.money(ingredient.lineCost)}` : '';
        const note = ingredient.note ? ` (${ingredient.note})` : '';
        doc.font('Times').fontSize(11).text(
          `${index + 1}. ${ingredient.name}: ${this.quantityLabel(ingredient.quantity, ingredient.unit)}${cost}${note}`,
        );
      });

      heading('Các bước thực hiện');
      recipe.steps.forEach((step, index) => {
        doc.font('Times Bold').text(`${index + 1}. ${step.title || `Bước ${index + 1}`}`);
        doc.font('Times').text(step.content);
        if (step.notes) doc.text(`Ghi chú: ${step.notes}`);
        doc.moveDown(0.4);
      });

      if (recipe.storage) {
        heading('Bảo quản');
        doc.font('Times').text(recipe.storage);
      }
      doc.end();
    });

    return { buffer, filename: `${slug}-${variant}.pdf`.replace(/[^a-z0-9.-]/g, '-') };
  }

  private async loadPublished(recipes: Array<any>) {
    if (!recipes.length) return [];
    const productIds = recipes.flatMap((recipe) =>
      recipe.ingredients.flatMap((ingredient) => ingredient.productId ?? []),
    ) as number[];
    const priceBook = await this.prisma.priceBook.findFirst({
      where: { name: { equals: 'Bảng Giá Lẻ HCM', mode: 'insensitive' }, isActive: true },
      select: { id: true },
    });
    const prices = priceBook && productIds.length
      ? await this.prisma.priceBookDetail.findMany({
          where: {
            priceBookId: priceBook.id,
            productId: { in: [...new Set(productIds)] },
            isActive: true,
          },
          select: { productId: true, price: true },
        })
      : [];
    const priceMap = new Map(prices.map((price) => [price.productId, Number(price.price)]));

    return recipes.map((recipe) => {
      const lineCosts: Array<number | null> = recipe.ingredients.map(
        (ingredient) => this.lineCost(ingredient, priceMap),
      );
      const totalCost = lineCosts.reduce<number>(
        (sum, cost) => sum + (cost == null ? 0 : cost),
        0,
      );
      const outputQuantity = Number(recipe.quantity);
      return {
        recipe,
        priceMap,
        cost: {
          totalCost,
          costPerOutputUnit: outputQuantity > 0 ? totalCost / outputQuantity : totalCost,
        },
      };
    });
  }

  private mapSummary(row: PublicRecipeRow) {
    const thumbnail = row.recipe.images.find((media) => media.mediaType === 'IMAGE');
    const quantity = row.recipe.quantity == null ? null : Number(row.recipe.quantity);
    const yieldUnit = row.recipe.unit || row.recipe.quantityUnit;
    return {
      slug: row.recipe.slug,
      code: row.recipe.code,
      name: row.recipe.name,
      type: row.recipe.type,
      category: row.recipe.category,
      description: row.recipe.description,
      yield: {
        quantity,
        quantityUnit: row.recipe.quantityUnit,
        unit: row.recipe.unit,
        label: this.quantityLabel(quantity, yieldUnit),
      },
      publishedAt: row.recipe.publishedAt,
      thumbnail: thumbnail?.fileUrl || null,
      mediaCounts: {
        images: row.recipe.images.filter((media) => media.mediaType === 'IMAGE').length,
        videos: row.recipe.images.filter((media) => media.mediaType === 'VIDEO').length,
      },
      totalCost: row.cost.totalCost,
      costPerOutputUnit: row.cost.costPerOutputUnit,
    };
  }

  private async getRelated(source: PublicRecipeRow) {
    const candidates = await this.prisma.recipe.findMany({
      where: {
        id: { not: source.recipe.id },
        status: 'PUBLISHED',
        deletedAt: null,
        slug: { not: null },
        OR: [
          ...(source.recipe.categoryId ? [{ categoryId: source.recipe.categoryId }] : []),
          { type: source.recipe.type },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 12,
      select: PUBLIC_RECIPE_SELECT,
    });
    const rows = await this.loadPublished(candidates);
    return rows.slice(0, 3).map((row) => this.mapSummary(row));
  }

  private lineCost(ingredient: any, priceMap: Map<number, number>): number | null {
    if (!ingredient.includeInCost) return 0;
    const quantity = Number(ingredient.quantity);
    if (ingredient.sourceType === 'CUSTOM') {
      return ingredient.customPrice == null ? null : Number(ingredient.customPrice) * quantity;
    }
    if (ingredient.sourceType === 'SEMI_FINISHED') {
      return ingredient.unitCostSnapshot == null
        ? null
        : Number(ingredient.unitCostSnapshot) * quantity;
    }
    const price = ingredient.productId ? priceMap.get(ingredient.productId) : undefined;
    const weightGram = this.toGram(ingredient.product?.weight, ingredient.product?.weightUnit);
    return price == null || weightGram == null ? null : (price / weightGram) * quantity;
  }

  private toGram(weight: unknown, unit?: string | null) {
    const value = Number(weight);
    if (!Number.isFinite(value) || value <= 0) return null;
    const normalized = unit?.trim().toLowerCase();
    if (normalized === 'kg') return value * 1000;
    if (normalized === 'g' || normalized === 'gram') return value;
    return null;
  }

  private quantityLabel(quantity: number | null, unit?: string | null) {
    return `${quantity == null ? '-' : quantity}${unit ? ` ${unit}` : ''}`;
  }

  private money(value: number | null) {
    return value == null ? 'Chưa xác định' : `${Math.round(value).toLocaleString('vi-VN')} đ`;
  }
}
