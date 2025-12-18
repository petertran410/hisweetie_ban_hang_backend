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
    const {
      imageUrls,
      components,
      initialInventory,
      branchId,
      costScope,
      costBranchId,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      categoryId,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      ...productData
    } = dto;

    const name = dto.name;
    const attributesText = dto.attributesText || null;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          code: productData.code,
          name: productData.name,
          fullName,
          description: productData.description,
          orderTemplate: productData.orderTemplate,
          type: productData.type || 2,
          allowsSale: productData.allowsSale,
          hasVariants: productData.hasVariants,
          basePrice: basePrice || 0,
          unit: productData.unit,
          conversionValue: productData.conversionValue,
          weight: productData.weight,
          weightUnit: productData.weightUnit,
          attributesText,
          isRewardPoint: productData.isRewardPoint,
          isActive: productData.isActive ?? true,
          isDirectSale: productData.isDirectSale ?? false,
          masterUnitId: masterUnitId,
          // ⚠️ XỬ LÝ RELATIONS
          ...(categoryId && {
            category: {
              connect: { id: categoryId },
            },
          }),
          ...(tradeMarkId && {
            tradeMark: {
              connect: { id: tradeMarkId },
            },
          }),
          ...(variantId && {
            variant: {
              connect: { id: variantId },
            },
          }),
          ...(masterProductId && {
            masterProduct: { connect: { id: masterProductId } },
          }),
        },
      });

      // 2. Tạo images
      if (imageUrls && imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url) => ({
            productId: product.id,
            image: url,
          })),
        });
      }

      // 3. ⚠️ TẠO INVENTORY THEO LOGIC MỚI
      const cost = purchasePrice || 0; // ⚠️ purchasePrice → cost
      const onHand = stockQuantity || 0; // ⚠️ stockQuantity → onHand
      const minQuality = minStockAlert || 0; // ⚠️ minStockAlert → minQuality
      const maxQuality = maxStockAlert || 0; // ⚠️ maxStockAlert → maxQuality

      // Lấy tất cả branches
      const allBranches = await tx.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      // ⚠️ LOGIC GIÁ VỐN
      let branchesToCreateInventory: { id: number; name: string }[] = [];

      if (costScope === 'all') {
        // Áp dụng giá vốn cho TẤT CẢ chi nhánh
        branchesToCreateInventory = allBranches;
      } else if (costScope === 'specific' && costBranchId) {
        // Chỉ áp dụng giá vốn cho chi nhánh được chọn
        const selectedBranch = allBranches.find((b) => b.id === costBranchId);
        if (selectedBranch) {
          branchesToCreateInventory = [selectedBranch];
        }
      } else {
        // Mặc định: không có scope (backward compatible)
        if (branchId) {
          const currentBranch = allBranches.find((b) => b.id === branchId);
          if (currentBranch) {
            branchesToCreateInventory = [currentBranch];
          }
        }
      }

      // Tạo inventory records
      const inventoryData = branchesToCreateInventory.map((branch) => {
        const isCurrentBranch = branch.id === branchId;

        return {
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          branchId: branch.id,
          branchName: branch.name,
          cost: cost, // ⚠️ Giá vốn
          onHand: isCurrentBranch ? onHand : 0,
          reserved: 0,
          onOrder: 0,
          minQuality: isCurrentBranch ? minQuality : 0,
          maxQuality: isCurrentBranch ? maxQuality : 0,
        };
      });

      if (inventoryData.length > 0) {
        await tx.inventory.createMany({ data: inventoryData });
      }

      // 4. Tạo combo components (nếu là combo)
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

    const {
      imageUrls,
      components,
      initialInventory,
      branchId,
      costScope,
      costBranchId,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      categoryId,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      ...productData
    } = dto;

    return this.prisma.$transaction(async (tx) => {
      // 1. ⚠️ UPDATE PRODUCT - CHỈ VỚI CÁC FIELDS TỒN TẠI
      const product = await tx.product.update({
        where: { id },
        data: {
          ...productData,
          fullName,
          basePrice:
            basePrice !== undefined ? basePrice : currentProduct.basePrice,
          ...(masterUnitId !== undefined && { masterUnitId }),
          ...(categoryId !== undefined && {
            category: categoryId
              ? { connect: { id: categoryId } }
              : { disconnect: true },
          }),
          ...(tradeMarkId !== undefined && {
            tradeMark: tradeMarkId
              ? { connect: { id: tradeMarkId } }
              : { disconnect: true },
          }),
          ...(variantId !== undefined && {
            variant: variantId
              ? { connect: { id: variantId } }
              : { disconnect: true },
          }),
          ...(masterProductId !== undefined && {
            masterProduct: masterProductId
              ? { connect: { id: masterProductId } }
              : { disconnect: true },
          }),
        },
      });

      // 2. Update images
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

      // 3. ⚠️ UPDATE INVENTORY THEO LOGIC MỚI
      const cost = purchasePrice;
      const onHand = stockQuantity;
      const minQuality = minStockAlert;
      const maxQuality = maxStockAlert;

      // ⚠️ LOGIC GIÁ VỐN KHI CẬP NHẬT
      if (
        cost !== undefined &&
        (costScope === 'all' || costScope === 'specific')
      ) {
        // Lấy tất cả branches
        const allBranches = await tx.branch.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
        });

        let branchesToUpdateCost: { id: number; name: string }[] = [];

        if (costScope === 'all') {
          // Cập nhật giá vốn cho TẤT CẢ chi nhánh
          branchesToUpdateCost = allBranches;
        } else if (costScope === 'specific' && costBranchId) {
          // Chỉ cập nhật giá vốn cho chi nhánh được chọn
          const selectedBranch = allBranches.find((b) => b.id === costBranchId);
          if (selectedBranch) {
            branchesToUpdateCost = [selectedBranch];
          }
        }

        // Cập nhật/Tạo inventory cho các chi nhánh
        for (const branch of branchesToUpdateCost) {
          const isCurrentBranch = branch.id === branchId;

          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: id,
                branchId: branch.id,
              },
            },
            create: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branch.id,
              branchName: branch.name,
              cost: cost,
              onHand: isCurrentBranch && onHand !== undefined ? onHand : 0,
              reserved: 0,
              onOrder: 0,
              minQuality:
                isCurrentBranch && minQuality !== undefined ? minQuality : 0,
              maxQuality:
                isCurrentBranch && maxQuality !== undefined ? maxQuality : 0,
            },
            update: {
              cost: cost, // ⚠️ CẬP NHẬT GIÁ VỐN
              // ⚠️ CHỈ CẬP NHẬT TỒN KHO NẾU LÀ CHI NHÁNH HIỆN TẠI
              ...(isCurrentBranch && onHand !== undefined && { onHand }),
              ...(isCurrentBranch &&
                minQuality !== undefined && { minQuality }),
              ...(isCurrentBranch &&
                maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      } else {
        // ⚠️ KHÔNG CÓ SCOPE: CHỈ CẬP NHẬT CHI NHÁNH HIỆN TẠI
        if (branchId) {
          const branch = await tx.branch.findUnique({
            where: { id: branchId },
            select: { name: true },
          });

          await tx.inventory.upsert({
            where: {
              productId_branchId: {
                productId: id,
                branchId: branchId,
              },
            },
            create: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branchId,
              branchName: branch?.name || '',
              cost: cost || 0,
              onHand: onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: minQuality || 0,
              maxQuality: maxQuality || 0,
            },
            update: {
              ...(cost !== undefined && { cost }),
              ...(onHand !== undefined && { onHand }),
              ...(minQuality !== undefined && { minQuality }),
              ...(maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      }

      // 4. Update combo components
      if (components !== undefined) {
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
    const allInventories = await this.prisma.inventory.findMany({
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
    });

    return allInventories.filter(
      (inv) => Number(inv.onHand) <= Number(inv.minQuality),
    );
  }
}
