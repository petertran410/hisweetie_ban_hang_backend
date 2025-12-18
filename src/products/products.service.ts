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
      ...productData
    } = dto;

    const name = dto.name;
    const attributesText = dto.attributesText || null;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    return this.prisma.$transaction(async (tx) => {
      // 1. Tạo product
      const product = await tx.product.create({
        data: {
          ...productData,
          fullName,
          basePrice: dto.basePrice || dto.retailPrice || 0,
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
      const purchasePrice = dto.purchasePrice || 0;
      const onHand = dto.stockQuantity || 0;
      const minQuality = dto.minStockAlert || 0;
      const maxQuality = dto.maxStockAlert || 0;

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
        // Hoặc có thể fallback về chi nhánh hiện tại
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
          cost: purchasePrice, // Giá vốn cho các chi nhánh theo scope
          onHand: isCurrentBranch ? onHand : 0, // ⚠️ CHỈ CHI NHÁNH HIỆN TẠI CÓ TỒN KHO
          reserved: 0,
          onOrder: 0,
          minQuality: isCurrentBranch ? minQuality : 0, // ⚠️ CHỈ CHI NHÁNH HIỆN TẠI
          maxQuality: isCurrentBranch ? maxQuality : 0, // ⚠️ CHỈ CHI NHÁNH HIỆN TẠI
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
      ...productData
    } = dto;

    return this.prisma.$transaction(async (tx) => {
      // 1. Update product
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
      const purchasePrice = dto.purchasePrice;
      const onHand = dto.stockQuantity;
      const minQuality = dto.minStockAlert;
      const maxQuality = dto.maxStockAlert;

      // ⚠️ LOGIC GIÁ VỐN KHI CẬP NHẬT
      if (
        purchasePrice !== undefined &&
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
              cost: purchasePrice,
              onHand: isCurrentBranch && onHand !== undefined ? onHand : 0,
              reserved: 0,
              onOrder: 0,
              minQuality:
                isCurrentBranch && minQuality !== undefined ? minQuality : 0,
              maxQuality:
                isCurrentBranch && maxQuality !== undefined ? maxQuality : 0,
            },
            update: {
              cost: purchasePrice, // ⚠️ CẬP NHẬT GIÁ VỐN
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
              cost: purchasePrice || 0,
              onHand: onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: minQuality || 0,
              maxQuality: maxQuality || 0,
            },
            update: {
              ...(purchasePrice !== undefined && { cost: purchasePrice }),
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
