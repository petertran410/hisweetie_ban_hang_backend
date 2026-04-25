import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

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

  private calculateTotalWeight(
    weight: any,
    weightUnit: string | null | undefined,
    onHand: any,
  ): number {
    const weightValue = weight ? Number(weight) : 0;
    const onHandValue = onHand ? Number(onHand) : 0;

    if (weightValue === 0) return 0;

    return weightValue * onHandValue;
  }

  private async syncTotalWeightToInventories(
    productId: number,
    weight: any,
    weightUnit: string | null | undefined,
    tx: any,
  ) {
    const inventories = await tx.inventory.findMany({
      where: { productId },
      select: { branchId: true, onHand: true },
    });

    for (const inv of inventories) {
      const totalWeight = this.calculateTotalWeight(
        weight,
        weightUnit,
        inv.onHand,
      );

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId,
            branchId: inv.branchId,
          },
        },
        data: { totalWeight },
      });
    }
  }

  private calculateManufacturingCost(
    components: { componentProductId: number; quantity: number }[],
    componentProducts: any[],
    costMap: Map<number, number>,
    productType: number,
  ): number {
    return components.reduce((sum, comp) => {
      const componentCost = costMap.get(comp.componentProductId) || 0;
      const quantity = Number(comp.quantity);

      if (productType === 4) {
        const componentProduct = componentProducts.find(
          (p) => p.id === comp.componentProductId,
        );
        if (!componentProduct) return sum;

        const weight = componentProduct.weight
          ? Number(componentProduct.weight)
          : 0;
        if (weight === 0) return sum;

        const weightInGrams =
          componentProduct.weightUnit === 'kg' ? weight * 1000 : weight;

        return sum + (componentCost / weightInGrams) * quantity;
      }

      return sum + componentCost * quantity;
    }, 0);
  }

  async findAll(query: ProductQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      categoryIds,
      isActive,
      branchId,
      branchIds,
      type,
      types,
      parentName,
      middleName,
      childName,
      stockStatus,
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

    if (type !== undefined) where.type = type;

    if (types && types.length > 0) where.type = { in: types };

    if (parentName) where.parentName = parentName;
    if (middleName) where.middleName = middleName;
    if (childName) where.childName = childName;

    if (stockStatus === 'instock') {
      where.inventories = { some: { onHand: { gt: 0 } } };
    } else if (stockStatus === 'outstock') {
      where.inventories = { every: { onHand: { lte: 0 } } };
    }

    let inventoriesInclude: any = { include: { branch: true } };
    if (branchIds && branchIds.length > 0) {
      inventoriesInclude = {
        where: { branchId: { in: branchIds } },
        include: { branch: true },
      };
    } else if (branchId) {
      inventoriesInclude = {
        where: { branchId },
        include: { branch: true },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          tradeMark: true,
          variant: true,
          images: true,
          inventories: inventoriesInclude,
          comboComponents: {
            include: {
              componentProduct: {
                include: { images: true, inventories: true },
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
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        variant: true,
        tradeMark: true,
        images: true,
        inventories: {
          include: { branch: true },
        },
        comboComponents: {
          include: {
            componentProduct: {
              include: {
                images: true,
                inventories: true,
              },
            },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    return product;
  }

  async checkCodeExists(code: string, excludeId?: number): Promise<boolean> {
    const existing = await this.prisma.product.findUnique({
      where: { code },
    });

    if (!existing) return false;
    if (excludeId && existing.id === excludeId) return false;

    return true;
  }

  async create(dto: CreateProductDto, userId?: number) {
    const {
      imageUrls,
      components,
      initialInventory,
      branchId,
      costScope,
      costBranchIds,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      parentName,
      middleName,
      childName,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      manualCostOverride,
      ...productData
    } = dto;

    const name = dto.name;
    const attributesText = dto.attributesText || null;
    const fullName = dto.fullName || this.buildFullName(name, attributesText);

    return this.prisma.$transaction(async (tx) => {
      const productCode =
        productData.code || (await this.generateSafeProductCode(tx));

      const product = await tx.product.create({
        data: {
          code: productCode,
          name: productData.name,
          fullName,
          description: productData.description,
          orderTemplate: productData.orderTemplate,
          parentName: parentName || null,
          middleName: middleName || null,
          childName: childName || null,
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
          isPieceUnit: productData.isPieceUnit ?? false,
          masterUnitId: masterUnitId,
          ...(masterUnitId && { masterUnitId }),
          ...(tradeMarkId && {
            tradeMark: { connect: { id: tradeMarkId } },
          }),
          ...(variantId && {
            variant: { connect: { id: variantId } },
          }),
          ...(masterProductId && {
            masterProduct: { connect: { id: masterProductId } },
          }),
        },
      });

      if (imageUrls && imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url) => ({
            productId: product.id,
            image: url,
          })),
        });
      }

      const allBranches = await tx.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      const cost = purchasePrice || 0;
      const onHand = stockQuantity || 0;
      const minQuality = minStockAlert || 0;
      const maxQuality = maxStockAlert || 0;

      let branchesToCreateInventory: { id: number; name: string }[] = [];

      if (costScope === 'all') {
        branchesToCreateInventory = allBranches;
      } else if (
        costScope === 'specific' &&
        costBranchIds &&
        costBranchIds.length > 0
      ) {
        branchesToCreateInventory = allBranches.filter((b) =>
          costBranchIds.includes(b.id),
        );
      } else {
        if (branchId) {
          const currentBranch = allBranches.find((b) => b.id === branchId);
          if (currentBranch) {
            branchesToCreateInventory = [currentBranch];
          }
        }
      }

      const inventoryData = await Promise.all(
        branchesToCreateInventory.map(async (branch) => {
          const isCurrentBranch =
            branchId !== undefined && branch.id === branchId;

          let branchCost = cost;
          if (
            !dto.manualCostOverride &&
            (dto.type === 1 || dto.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branch.id,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              dto.type,
            );
          }

          const branchOnHand = isCurrentBranch ? onHand : 0;
          const totalWeight = this.calculateTotalWeight(
            dto.weight,
            dto.weightUnit,
            branchOnHand,
          );

          return {
            productId: product.id,
            productCode: product.code,
            productName: product.name,
            branchId: branch.id,
            branchName: branch.name,
            cost: branchCost,
            onHand: branchOnHand,
            reserved: 0,
            onOrder: 0,
            minQuality: isCurrentBranch ? minQuality : 0,
            maxQuality: isCurrentBranch ? maxQuality : 0,
            totalWeight: totalWeight,
          };
        }),
      );

      if (inventoryData.length > 0) {
        await tx.inventory.createMany({ data: inventoryData });
      }

      if (
        !dto.manualCostOverride &&
        (dto.type === 1 || dto.type === 4) &&
        components &&
        components.length > 0
      ) {
        await tx.productComponent.createMany({
          data: components.map((comp) => ({
            comboProductId: product.id,
            componentProductId: comp.componentProductId,
            quantity: comp.quantity,
            inputMode: comp.inputMode ?? 'gram',
          })),
        });
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const finalProduct = await tx.product.findUnique({
          where: { id: product.id },
          include: { variant: true, tradeMark: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'PRODUCT_CREATE',
          entityType: 'products',
          entityId: product.id.toString(),
          entityCode: product.code,
          category: getCategoryFromActionCode('PRODUCT_CREATE'),
          severity: getSeverityFromActionCode('PRODUCT_CREATE'),
          snapshot: this.buildProductSnapshot(finalProduct || product),
          message: renderAuditMessage('PRODUCT_CREATE', {
            productName: product.name,
            productCode: product.code,
            basePrice: Number(product.basePrice || 0),
          }),
          messageTemplate: 'PRODUCT_CREATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: user?.branchId || undefined,
        });
      }

      return tx.product.findUnique({
        where: { id: product.id },
        include: {
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

  async update(id: number, dto: UpdateProductDto, userId?: number) {
    const currentProduct = await this.prisma.product.findUnique({
      where: { id },
      include: {
        images: true,
        comboComponents: true,
        inventories: true,
        variant: true,
        tradeMark: true,
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
      costBranchIds,
      purchasePrice,
      basePrice,
      stockQuantity,
      minStockAlert,
      maxStockAlert,
      parentName,
      middleName,
      childName,
      tradeMarkId,
      variantId,
      masterProductId,
      masterUnitId,
      manualCostOverride,
      ...productData
    } = dto;

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          ...productData,
          fullName,
          basePrice:
            basePrice !== undefined ? basePrice : currentProduct.basePrice,
          ...(masterUnitId !== undefined && { masterUnitId }),
          ...(parentName !== undefined && { parentName: parentName || null }),
          ...(middleName !== undefined && { middleName: middleName || null }),
          ...(childName !== undefined && { childName: childName || null }),
          isPieceUnit: dto.isPieceUnit ?? undefined,
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

      if (dto.code || dto.name) {
        const newCode = dto.code || currentProduct.code;
        const newName = dto.name || currentProduct.name;
        await this.syncProductInfoToInventories(id, newCode, newName, tx);
      }

      if (dto.weight !== undefined || dto.weightUnit !== undefined) {
        const newWeight =
          dto.weight !== undefined ? dto.weight : currentProduct.weight;
        const newWeightUnit =
          dto.weightUnit !== undefined
            ? dto.weightUnit
            : currentProduct.weightUnit;
        await this.syncTotalWeightToInventories(
          id,
          newWeight,
          newWeightUnit,
          tx,
        );
      }

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

      const cost = purchasePrice;
      const onHand = stockQuantity;
      const minQuality = minStockAlert;
      const maxQuality = maxStockAlert;

      if (
        cost !== undefined &&
        (costScope === 'all' || costScope === 'specific')
      ) {
        const allBranches = await tx.branch.findMany({
          where: { isActive: true },
          select: { id: true, name: true },
        });

        let branchesToUpdateCost: { id: number; name: string }[] = [];

        if (costScope === 'all') {
          branchesToUpdateCost = allBranches;
        } else if (
          costScope === 'specific' &&
          costBranchIds &&
          costBranchIds.length > 0
        ) {
          branchesToUpdateCost = allBranches.filter((b) =>
            costBranchIds.includes(b.id),
          );
        }

        for (const branch of branchesToUpdateCost) {
          const isCurrentBranch = branch.id === branchId;

          let branchCost = cost;

          if (
            !dto.manualCostOverride &&
            (currentProduct.type === 1 || currentProduct.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branch.id,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              currentProduct.type,
            );
          }

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
              cost: branchCost,
              onHand: isCurrentBranch && onHand !== undefined ? onHand : 0,
              reserved: 0,
              onOrder: 0,
              minQuality:
                isCurrentBranch && minQuality !== undefined ? minQuality : 0,
              maxQuality:
                isCurrentBranch && maxQuality !== undefined ? maxQuality : 0,
              totalWeight: this.calculateTotalWeight(
                product.weight,
                product.weightUnit,
                isCurrentBranch && onHand !== undefined ? onHand : 0,
              ),
            },
            update: {
              cost: branchCost,
              productCode: product.code,
              productName: product.name,
              ...(isCurrentBranch &&
                onHand !== undefined && {
                  onHand,
                  totalWeight: this.calculateTotalWeight(
                    product.weight,
                    product.weightUnit,
                    onHand,
                  ),
                }),
              ...(isCurrentBranch &&
                minQuality !== undefined && { minQuality }),
              ...(isCurrentBranch &&
                maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      } else if (cost !== undefined) {
        if (branchId) {
          const branch = await tx.branch.findUnique({
            where: { id: branchId },
            select: { name: true },
          });

          let branchCost = cost;

          if (
            !dto.manualCostOverride &&
            (currentProduct.type === 1 || currentProduct.type === 4) &&
            components &&
            components.length > 0
          ) {
            const componentProducts = await tx.product.findMany({
              where: {
                id: { in: components.map((c) => c.componentProductId) },
              },
              select: {
                id: true,
                weight: true,
                weightUnit: true,
              },
            });

            const componentInventories = await tx.inventory.findMany({
              where: {
                productId: { in: components.map((c) => c.componentProductId) },
                branchId: branchId,
              },
              select: {
                productId: true,
                cost: true,
              },
            });

            const costMap = new Map(
              componentInventories.map((inv) => [
                inv.productId,
                Number(inv.cost),
              ]),
            );

            branchCost = this.calculateManufacturingCost(
              components,
              componentProducts,
              costMap,
              currentProduct.type,
            );
          }

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
              cost: branchCost,
              onHand: onHand || 0,
              reserved: 0,
              onOrder: 0,
              minQuality: minQuality || 0,
              maxQuality: maxQuality || 0,
              totalWeight: this.calculateTotalWeight(
                product.weight,
                product.weightUnit,
                onHand || 0,
              ),
            },
            update: {
              cost: branchCost,
              productCode: product.code,
              productName: product.name,
              ...(onHand !== undefined && {
                onHand,
                totalWeight: this.calculateTotalWeight(
                  product.weight,
                  product.weightUnit,
                  onHand,
                ),
              }),
              ...(minQuality !== undefined && { minQuality }),
              ...(maxQuality !== undefined && { maxQuality }),
            },
          });
        }
      }

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
              inputMode: comp.inputMode ?? 'gram',
            })),
          });
        }
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        });

        const updatedProduct = await tx.product.findUnique({
          where: { id },
          include: { variant: true, tradeMark: true },
        });

        const changes = buildChanges(
          'products',
          {
            name: currentProduct.name,
            basePrice: Number(currentProduct.basePrice || 0),
            weight: Number(currentProduct.weight || 0),
            weightUnit: currentProduct.weightUnit,
            unit: currentProduct.unit,
            isActive: currentProduct.isActive,
            allowsSale: currentProduct.allowsSale,
            isRewardPoint: currentProduct.isRewardPoint,
            description: currentProduct.description,
          },
          {
            name: updatedProduct?.name,
            basePrice: Number(updatedProduct?.basePrice || 0),
            weight: Number(updatedProduct?.weight || 0),
            weightUnit: updatedProduct?.weightUnit,
            unit: updatedProduct?.unit,
            isActive: updatedProduct?.isActive,
            allowsSale: updatedProduct?.allowsSale,
            isRewardPoint: updatedProduct?.isRewardPoint,
            description: updatedProduct?.description,
          },
        );

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PRODUCT_UPDATE',
          entityType: 'products',
          entityId: id.toString(),
          entityCode: updatedProduct?.code || currentProduct.code,
          category: getCategoryFromActionCode('PRODUCT_UPDATE'),
          severity: getSeverityFromActionCode('PRODUCT_UPDATE'),
          snapshot: this.buildProductSnapshot(updatedProduct || currentProduct),
          changes: changes.length > 0 ? changes : null,
          message: renderAuditMessage('PRODUCT_UPDATE', {
            productName: updatedProduct?.name || currentProduct.name,
            productCode: updatedProduct?.code || currentProduct.code,
          }),
          messageTemplate: 'PRODUCT_UPDATE',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: user?.branchId || undefined,
        });
      }

      return tx.product.findUnique({
        where: { id },
        include: {
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

  async remove(id: number, userId?: number) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { variant: true, tradeMark: true },
    });

    await this.prisma.product.delete({ where: { id } });

    if (userId && product) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRODUCT_DELETE',
        entityType: 'products',
        entityId: id.toString(),
        entityCode: product.code,
        category: getCategoryFromActionCode('PRODUCT_DELETE'),
        severity: getSeverityFromActionCode('PRODUCT_DELETE'),
        snapshot: this.buildProductSnapshot(product),
        message: renderAuditMessage('PRODUCT_DELETE', {
          productName: product.name,
          productCode: product.code,
        }),
        messageTemplate: 'PRODUCT_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return { message: 'Xóa sản phẩm thành công' };
  }

  async findInventoryLogs(
    productId: number,
    branchId?: number,
    page = 1,
    limit = 5,
  ) {
    const where: any = { productId };
    if (branchId) where.branchId = branchId;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.inventoryLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inventoryLog.count({ where }),
    ]);

    return { data, total };
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

  private async generateSafeProductCode(tx: any): Promise<string> {
    const prefix = 'SP';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allProducts = await tx.product.findMany({
        where: {
          code: {
            startsWith: prefix,
          },
        },
        select: {
          code: true,
        },
        orderBy: {
          id: 'desc',
        },
      });

      const validCodes = allProducts
        .map((prod: any) => prod.code)
        .filter((code: string) => regex.test(code))
        .sort((a, b) => {
          const numA = parseInt(a.replace(prefix, ''));
          const numB = parseInt(b.replace(prefix, ''));
          return numB - numA;
        });

      let nextNumber = 1;
      if (validCodes.length > 0) {
        const lastCode = validCodes[0];
        const match = lastCode.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0]) + 1;
        }
      }

      const code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

      const exists = await tx.product.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã sản phẩm duy nhất');
  }

  private async syncProductInfoToInventories(
    productId: number,
    newCode: string,
    newName: string,
    tx: any,
  ) {
    await tx.inventory.updateMany({
      where: { productId },
      data: {
        productCode: newCode,
        productName: newName,
      },
    });
  }

  private buildProductSnapshot(product: any) {
    return {
      code: product.code,
      name: product.name,
      fullName: product.fullName,
      basePrice: product.basePrice ? Number(product.basePrice) : 0,
      weight: product.weight ? Number(product.weight) : 0,
      weightUnit: product.weightUnit,
      unit: product.unit,
      type: product.type,
      isActive: product.isActive,
      allowsSale: product.allowsSale,
      isRewardPoint: product.isRewardPoint,
      isDirectSale: product.isDirectSale,
      description: product.description,
      variant: product.variant ? { name: product.variant.name } : null,
      tradeMark: product.tradeMark ? { name: product.tradeMark.name } : null,
    };
  }
}
