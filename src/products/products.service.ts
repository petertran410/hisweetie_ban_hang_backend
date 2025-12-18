import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private parseAttributes(
    attributesText: string | null,
  ): { name: string; value: string }[] {
    if (!attributesText) return [];
    return attributesText.split('|').map((attr) => {
      const [name, value] = attr.split(':');
      return { name: name?.trim() || '', value: value?.trim() || '' };
    });
  }

  private buildFullName(name: string, attributesText: string | null): string {
    if (!attributesText) return name;

    const attrs = this.parseAttributes(attributesText);
    if (attrs.length === 0) return name;

    const attrValues = attrs.map((attr) => attr.value).join(' - ');
    return `${name} - ${attrValues}`;
  }

  async findAll(query: ProductQueryDto) {
    const {
      page = 1,
      limit = 15,
      search,
      categoryIds,
      isActive,
      branchId,
    } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (categoryIds) {
      const categoryIdArray = categoryIds
        .split(',')
        .map((id) => parseInt(id.trim()));
      where.categoryId = { in: categoryIdArray };
    }

    if (isActive !== undefined) where.isActive = isActive;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          category: true,
          tradeMark: true,
          variant: true,
          images: true,
          inventories: branchId
            ? {
                where: { branchId: parseInt(branchId) },
                include: { branch: true },
              }
            : {
                include: { branch: true },
              },
          comboComponents: {
            include: {
              componentProduct: {
                include: {
                  images: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        variant: true,
        tradeMark: true,
        images: true,
        inventories: {
          include: {
            branch: true,
          },
        },
        comboComponents: {
          include: {
            componentProduct: {
              include: {
                images: true,
              },
            },
          },
        },
      },
    });
  }

  async checkCodeExists(code: string, excludeId?: number): Promise<boolean> {
    const existing = await this.prisma.product.findUnique({
      where: { code },
    });

    if (!existing) return false;
    if (excludeId && existing.id === excludeId) return false;

    return true;
  }

  async create(dto: CreateProductDto) {
    const codeExists = await this.checkCodeExists(dto.code);
    if (codeExists) {
      throw new BadRequestException(
        `Product with code ${dto.code} already exists`,
      );
    }

    const fullName =
      dto.fullName || this.buildFullName(dto.name, dto.attributesText || null);

    const { imageUrls, components, initialInventory, ...productData } = dto;

    return this.prisma.$transaction(async (tx) => {
      // Tạo product
      const product = await tx.product.create({
        data: {
          ...productData,
          fullName,
          type: dto.type || 2,
          basePrice: dto.basePrice || 0,
        },
      });

      // Tạo images
      if (imageUrls && imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url) => ({
            productId: product.id,
            image: url,
          })),
        });
      }

      // Tạo inventory cho các chi nhánh
      if (initialInventory && initialInventory.length > 0) {
        const inventoryData = await Promise.all(
          initialInventory.map(async (inv) => {
            const branch = await tx.branch.findUnique({
              where: { id: inv.branchId },
              select: { name: true },
            });

            return {
              productId: product.id,
              productCode: product.code,
              productName: product.name,
              branchId: inv.branchId,
              branchName: inv.branchName || branch?.name || '',
              cost: inv.cost || 0,
              onHand: inv.onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: inv.minQuality || 0,
              maxQuality: inv.maxQuality || 0,
            };
          }),
        );

        await tx.inventory.createMany({ data: inventoryData });
      }

      // Tạo combo components (nếu là combo)
      if (dto.type === 1 && components && components.length > 0) {
        await tx.productComponent.createMany({
          data: components.map((comp) => ({
            comboProductId: product.id,
            componentProductId: comp.componentProductId,
            quantity: comp.quantity,
          })),
        });
      }

      return tx.product.findUnique({
        where: { id: product.id },
        include: {
          category: true,
          variant: true,
          tradeMark: true,
          images: true,
          inventories: {
            include: { branch: true },
          },
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true },
              },
            },
          },
        },
      });
    });
  }

  async update(id: number, dto: UpdateProductDto) {
    const currentProduct = await this.prisma.product.findUnique({
      where: { id },
      include: {
        images: true,
        comboComponents: true,
        inventories: true,
      },
    });

    if (!currentProduct) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    const name = dto.name || currentProduct.name;
    const attributesText =
      dto.attributesText !== undefined
        ? dto.attributesText
        : currentProduct.attributesText;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    const { imageUrls, components, initialInventory, ...productData } = dto;

    return this.prisma.$transaction(async (tx) => {
      // Update product
      const product = await tx.product.update({
        where: { id },
        data: {
          ...productData,
          fullName,
          basePrice:
            dto.basePrice !== undefined
              ? dto.basePrice
              : currentProduct.basePrice,
        },
      });

      // Update images
      if (imageUrls !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        if (imageUrls.length > 0) {
          await tx.productImage.createMany({
            data: imageUrls.map((url) => ({
              productId: id,
              image: url,
            })),
          });
        }
      }

      // Update inventory
      if (initialInventory && initialInventory.length > 0) {
        for (const inv of initialInventory) {
          const branch = await tx.branch.findUnique({
            where: { id: inv.branchId },
            select: { name: true },
          });

          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: id,
                branchId: inv.branchId,
              },
            },
            create: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: inv.branchId,
              branchName: inv.branchName || branch?.name || '',
              cost: inv.cost || 0,
              onHand: inv.onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: inv.minQuality || 0,
              maxQuality: inv.maxQuality || 0,
            },
            update: {
              cost: inv.cost !== undefined ? inv.cost : undefined,
              onHand: inv.onHand !== undefined ? inv.onHand : undefined,
              minQuality:
                inv.minQuality !== undefined ? inv.minQuality : undefined,
              maxQuality:
                inv.maxQuality !== undefined ? inv.maxQuality : undefined,
            },
          });
        }
      }

      // Update combo components
      if (dto.type === 1 && components !== undefined) {
        await tx.productComponent.deleteMany({
          where: { comboProductId: id },
        });
        if (components.length > 0) {
          await tx.productComponent.createMany({
            data: components.map((comp) => ({
              comboProductId: id,
              componentProductId: comp.componentProductId,
              quantity: comp.quantity,
            })),
          });
        }
      }

      return tx.product.findUnique({
        where: { id },
        include: {
          category: true,
          variant: true,
          tradeMark: true,
          images: true,
          inventories: {
            include: { branch: true },
          },
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true },
              },
            },
          },
        },
      });
    });
  }

  async remove(id: number) {
    return this.prisma.product.delete({ where: { id } });
  }

  async checkLowStock() {
    return this.prisma.inventory.findMany({
      where: {
        onHand: {
          lte: this.prisma.raw('min_quality'),
        },
      },
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ branchName: 'asc' }, { productName: 'asc' }],
    });
  }
}
