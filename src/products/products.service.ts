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
      limit,
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
      priceBookId,
      onlyInPriceBook,
    } = query;
    const skip = limit ? (page - 1) * limit : 0;

    const where: any = {};
    if (search) {
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      let matchedIds: { id: number }[];
      if (tokens.length <= 1) {
        matchedIds = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "products"
      WHERE (
        unaccent(lower(name)) LIKE unaccent(lower(${`%${search}%`}))
        OR lower(code) LIKE lower(${`%${search}%`})
      )
    `;
      } else {
        const tokenSets = await Promise.all(
          tokens.map(
            (t) =>
              this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "products"
          WHERE (
            unaccent(lower(name)) LIKE unaccent(lower(${`%${t}%`}))
            OR lower(code) LIKE lower(${`%${t}%`})
          )
        `,
          ),
        );
        const idSets = tokenSets.map((rows) => new Set(rows.map((r) => r.id)));
        matchedIds = tokenSets[0].filter((r) =>
          idSets.every((s) => s.has(r.id)),
        );
      }

      where.id = {
        in: matchedIds.length > 0 ? matchedIds.map((r) => r.id) : [-1],
      };
    }

    if (priceBookId && priceBookId > 0 && onlyInPriceBook) {
      const pb = await this.prisma.priceBook.findUnique({
        where: { id: priceBookId },
        select: { allowNonListedProducts: true },
      });
      if (pb && !pb.allowNonListedProducts) {
        where.priceBookDetails = {
          some: { priceBookId, isActive: true },
        };
      }
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
        ...(limit ? { take: limit } : {}),
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

    console.log('[DEBUG CREATE] costScope:', costScope);
    console.log('[DEBUG CREATE] costBranchIds:', costBranchIds);
    console.log('[DEBUG CREATE] typeof costBranchIds:', typeof costBranchIds);
    console.log(
      '[DEBUG CREATE] Array.isArray(costBranchIds):',
      Array.isArray(costBranchIds),
    );

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

      console.log(
        '[DEBUG CREATE] branchesToCreateInventory:',
        branchesToCreateInventory.map((b) => ({ id: b.id, name: b.name })),
      );
      console.log('[DEBUG CREATE] inventoryData.length:', inventoryData.length);

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

      // Đọc giá trị onHand cũ để so sánh sau khi upsert
      let oldOnHand: number | null = null;
      if (onHand !== undefined && branchId) {
        const existingInventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: id,
              branchId: branchId,
            },
          },
          select: { onHand: true, cost: true },
        });
        oldOnHand = existingInventory ? Number(existingInventory.onHand) : 0;
      }

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

      // Tạo StockAudit + InventoryLog nếu tồn kho thay đổi
      if (onHand !== undefined && branchId && oldOnHand !== null) {
        const delta = Number(onHand) - oldOnHand;
        if (delta !== 0) {
          // Sinh mã KK tiếp theo (chung sequence với StockAudit)
          const lastAudit = await tx.stockAudit.findFirst({
            orderBy: { id: 'desc' },
            select: { code: true },
          });
          const nextNum = lastAudit
            ? parseInt(lastAudit.code.replace('KK', ''), 10) + 1
            : 1;
          const auditCode = `KK${String(nextNum).padStart(6, '0')}`;

          // Lấy thông tin branch
          const auditBranch = await tx.branch.findUnique({
            where: { id: branchId },
            select: { name: true },
          });

          // Lấy thông tin user
          let auditUserName = 'System';
          if (userId) {
            const auditUser = await tx.user.findUnique({
              where: { id: userId },
              select: { name: true, email: true },
            });
            auditUserName = auditUser?.name || auditUser?.email || 'System';
          }

          // Lấy cost hiện tại
          const currentInventory = await tx.inventory.findUnique({
            where: {
              productId_branchId: { productId: id, branchId },
            },
            select: { cost: true },
          });
          const currentCost = Number(currentInventory?.cost || 0);

          // Tạo StockAudit (status = 2: COMPLETED)
          const stockAudit = await tx.stockAudit.create({
            data: {
              code: auditCode,
              branchId: branchId,
              branchName: auditBranch?.name || '',
              checkDate: new Date(),
              note: `Điều chỉnh tồn kho từ trang sản phẩm: ${product.name}`,
              status: 2,
              createdById: userId || 1,
              createdByName: auditUserName,
              completedById: userId || 1,
              completedByName: auditUserName,
              completedAt: new Date(),
              details: {
                create: {
                  productId: id,
                  productCode: product.code,
                  productName: product.name,
                  unit: currentProduct.unit,
                  systemQuantity: oldOnHand,
                  actualQuantity: Number(onHand),
                  difference: delta,
                  costAtCheck: currentCost,
                  differenceValue: delta * currentCost,
                },
              },
            },
          });

          // Tạo InventoryLog
          await tx.inventoryLog.create({
            data: {
              productId: id,
              productCode: product.code,
              productName: product.name,
              branchId: branchId,
              branchName: auditBranch?.name || '',
              transactionType: 'STOCK_AUDIT',
              refCode: auditCode,
              refType: 'stock_audit',
              refId: stockAudit.id,
              quantity: delta,
              costPrice: currentCost,
              note: `Điều chỉnh tồn kho từ trang sản phẩm: ${product.name} (${oldOnHand} → ${onHand})`,
              createdByName: auditUserName,
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

    // Lấy toàn bộ log của product (+branch) — số lượng hữu hạn theo product nên
    // chấp nhận đánh đổi để gộp/lọc chính xác trước khi paginate.
    const rawLogs = await this.prisma.inventoryLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Bước 1: lọc bỏ log thuộc các chứng từ đã hủy.
    // refType lưu ở InventoryLog: invoice, return_order, supplier_return,
    // stock_audit, purchase_order, transfer, destruction, production…
    // Hiện chỉ những loại có khái niệm "Đã hủy" rõ ràng và phổ biến cần lọc:
    //   - invoice          → Invoice.status = 2 (CANCELLED)
    //   - return_order     → ReturnOrder.status = 5 (CANCELLED)
    //   - supplier_return  → SupplierReturn.status = 4 (CANCELLED)
    //   - stock_audit      → StockAudit.status = 3 (CANCELLED)
    const refIdsByType: Record<string, Set<number>> = {};
    for (const log of rawLogs) {
      if (!log.refType || !log.refId) continue;
      (refIdsByType[log.refType] ||= new Set()).add(log.refId);
    }

    const cancelledKeys = new Set<string>(); // `${refType}:${refId}`

    const collectCancelled = async (
      refType: string,
      ids: number[],
      finder: (ids: number[]) => Promise<{ id: number }[]>,
    ) => {
      if (ids.length === 0) return;
      const cancelled = await finder(ids);
      cancelled.forEach((row) => cancelledKeys.add(`${refType}:${row.id}`));
    };

    await Promise.all([
      collectCancelled(
        'invoice',
        Array.from(refIdsByType['invoice'] || []),
        (ids) =>
          this.prisma.invoice.findMany({
            where: { id: { in: ids }, status: 2 },
            select: { id: true },
          }),
      ),
      collectCancelled(
        'return_order',
        Array.from(refIdsByType['return_order'] || []),
        (ids) =>
          this.prisma.returnOrder.findMany({
            where: { id: { in: ids }, status: 5 },
            select: { id: true },
          }),
      ),
      collectCancelled(
        'supplier_return',
        Array.from(refIdsByType['supplier_return'] || []),
        (ids) =>
          this.prisma.supplierReturn.findMany({
            where: { id: { in: ids }, status: 4 },
            select: { id: true },
          }),
      ),
      collectCancelled(
        'stock_audit',
        Array.from(refIdsByType['stock_audit'] || []),
        (ids) =>
          this.prisma.stockAudit.findMany({
            where: { id: { in: ids }, status: 3 },
            select: { id: true },
          }),
      ),
    ]);

    const activeLogs = rawLogs.filter(
      (log) => !cancelledKeys.has(`${log.refType}:${log.refId}`),
    );

    // Bước 2: gộp các log cùng (refType, refCode, transactionType) thành 1 dòng
    // — sum quantity, các trường còn lại lấy theo dòng đại diện (mới nhất).
    // Bỏ qua merge khi refCode rỗng để không vô tình gộp các log "lẻ".
    type LogRow = (typeof activeLogs)[number];
    const mergedMap = new Map<string, LogRow>();
    const ungrouped: LogRow[] = [];

    for (const log of activeLogs) {
      if (!log.refCode) {
        ungrouped.push(log);
        continue;
      }
      const key = `${log.refType}|${log.refCode}|${log.transactionType}`;
      const existing = mergedMap.get(key);
      if (!existing) {
        mergedMap.set(key, { ...log });
      } else {
        // sum quantity (Prisma Decimal hỗ trợ + qua Number cast).
        existing.quantity = (
          Number(existing.quantity) + Number(log.quantity)
        ) as any;
      }
    }

    const merged = [...mergedMap.values(), ...ungrouped].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const total = merged.length;
    const skip = (page - 1) * limit;
    const data = merged.slice(skip, skip + limit);

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
