import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
} from './dto';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class ProductionsService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: ProductionQueryDto) {
    const {
      branchIds,
      status,
      fromManufacturedDate,
      toManufacturedDate,
      pageSize = 15,
      currentItem = 0,
      search,
    } = query;

    const where: any = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (fromManufacturedDate || toManufacturedDate) {
      where.manufacturedDate = {};
      if (fromManufacturedDate) {
        where.manufacturedDate.gte = new Date(fromManufacturedDate);
      }
      if (toManufacturedDate) {
        where.manufacturedDate.lte = new Date(toManufacturedDate);
      }
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { productName: { contains: search, mode: 'insensitive' } },
        { productCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, data] = await Promise.all([
      this.prisma.production.count({ where }),
      this.prisma.production.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      pageSize,
      data,
    };
  }

  async findOne(id: number) {
    const production = await this.prisma.production.findUnique({
      where: { id },
      include: { components: true },
    });

    if (!production) {
      throw new NotFoundException(`Production with ID ${id} not found`);
    }

    return production;
  }

  async create(dto: CreateProductionDto, userId: number) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: {
        comboComponents: {
          include: { componentProduct: true },
        },
      },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.type !== 4) {
      throw new BadRequestException(
        'Product must be a manufacturing product (type = 4)',
      );
    }
    if (!product.weight) {
      throw new BadRequestException(
        'Manufacturing product must have weight defined',
      );
    }

    const sourceBranch = await this.prisma.branch.findUnique({
      where: { id: dto.sourceBranchId },
    });
    if (!sourceBranch) throw new NotFoundException('Source branch not found');

    const destinationBranch = await this.prisma.branch.findUnique({
      where: { id: dto.destinationBranchId },
    });
    if (!destinationBranch)
      throw new NotFoundException('Destination branch not found');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    const lastProduction = await this.prisma.production.findFirst({
      orderBy: { id: 'desc' },
      select: { code: true },
    });

    let nextNumber = 1;
    if (lastProduction?.code) {
      const match = lastProduction.code.match(/\d+$/);
      if (match) nextNumber = parseInt(match[0]) + 1;
    }

    const code = dto.code || `SX${String(nextNumber).padStart(6, '0')}`;
    const totalCost = this.calculateTotalCost(
      product.comboComponents,
      dto.sourceBranchId,
      dto.quantity,
    );

    return await this.prisma.$transaction(async (tx) => {
      const production = await tx.production.create({
        data: {
          code,
          sourceBranchId: dto.sourceBranchId,
          sourceBranchName: sourceBranch.name,
          destinationBranchId: dto.destinationBranchId,
          destinationBranchName: destinationBranch.name,
          productId: dto.productId,
          productCode: product.code,
          productName: product.name,
          quantity: dto.quantity,
          totalCost: await totalCost,
          note: dto.note,
          status: dto.status || 1,
          createdById: userId,
          createdByName: user?.name || '',
          autoDeductComponents: dto.autoDeductComponents ?? true,
          manufacturedDate: dto.manufacturedDate
            ? new Date(dto.manufacturedDate)
            : new Date(),
        },
      });

      if (dto.status === 2 && dto.autoDeductComponents) {
        await this.processInventoryChanges(
          tx,
          product,
          dto.sourceBranchId,
          dto.destinationBranchId,
          dto.quantity,
          dto.components, // ← truyền actualComponents
        );
      }

      if (dto.components && dto.components.length > 0) {
        const componentDetails = await Promise.all(
          dto.components.map(async (c) => {
            const comp = product.comboComponents.find(
              (pc) => pc.componentProductId === c.componentProductId,
            );
            const componentProduct = comp?.componentProduct;
            const weightInGrams =
              componentProduct?.weightUnit === 'kg'
                ? Number(componentProduct.weight) * 1000
                : Number(componentProduct?.weight || 0);

            return {
              productionId: production.id,
              componentProductId: c.componentProductId,
              componentCode: componentProduct?.code || '',
              componentName: componentProduct?.name || '',
              formulaGrams: c.formulaGrams,
              actualGrams: c.actualGrams,
              unitsDeducted:
                weightInGrams > 0 ? c.actualGrams / weightInGrams : 0,
            };
          }),
        );

        await tx.productionComponent.createMany({ data: componentDetails });
      }

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'PRODUCTION_CREATE',
        entityType: 'productions',
        entityId: production.id.toString(),
        entityCode: production.code,
        category: getCategoryFromActionCode('PRODUCTION_CREATE'),
        severity: getSeverityFromActionCode('PRODUCTION_CREATE'),
        snapshot: this.buildProductionSnapshot(production),
        message: renderAuditMessage('PRODUCTION_CREATE', {
          productionCode: production.code,
        }),
        messageTemplate: 'PRODUCTION_CREATE',
        userId,
        userName: user?.name || 'System',
        branchId: dto.sourceBranchId,
      });

      return production;
    });
  }

  async update(id: number, dto: UpdateProductionDto, userId?: number) {
    const production = await this.findOne(id);

    const updateData: any = {};
    if (dto.quantity !== undefined) updateData.quantity = dto.quantity;
    if (dto.note !== undefined) updateData.note = dto.note;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.manufacturedDate !== undefined) {
      updateData.manufacturedDate = new Date(dto.manufacturedDate);
    }
    if (dto.autoDeductComponents !== undefined) {
      updateData.autoDeductComponents = dto.autoDeductComponents;
    }

    return await this.prisma.$transaction(async (tx) => {
      // ── Lưu components khi lưu tạm (status 1) ──────────────────────
      // Chỉ lưu data, KHÔNG xử lý tồn kho
      if (dto.status !== 2 && dto.components && dto.components.length > 0) {
        const productForDraft = await tx.product.findUnique({
          where: { id: production.productId },
          include: {
            comboComponents: {
              include: { componentProduct: true },
            },
          },
        });

        if (productForDraft) {
          await tx.productionComponent.deleteMany({
            where: { productionId: id },
          });

          const draftComponentDetails = dto.components.map((c) => {
            const comp = productForDraft.comboComponents.find(
              (pc) => pc.componentProductId === c.componentProductId,
            );
            const componentProduct = comp?.componentProduct;
            const weightInGrams =
              componentProduct?.weightUnit === 'kg'
                ? Number(componentProduct.weight) * 1000
                : Number(componentProduct?.weight || 0);

            return {
              productionId: id,
              componentProductId: c.componentProductId,
              componentCode: componentProduct?.code || '',
              componentName: componentProduct?.name || '',
              formulaGrams: c.formulaGrams,
              actualGrams: c.actualGrams,
              unitsDeducted:
                weightInGrams > 0 ? c.actualGrams / weightInGrams : 0,
            };
          });

          await tx.productionComponent.createMany({
            data: draftComponentDetails,
          });
        }
      }
      // ───────────────────────────────────────────────────────────────

      // Trường hợp 1: Phiếu tạm (1) → Hoàn thành (2)
      // Xử lý tồn kho + lưu components
      if (dto.status === 2 && production.status !== 2) {
        const product = await tx.product.findUnique({
          where: { id: production.productId },
          include: {
            comboComponents: {
              include: { componentProduct: true },
            },
          },
        });

        if (product && updateData.autoDeductComponents !== false) {
          await this.processInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
            Number(dto.quantity ?? production.quantity),
            dto.components,
          );
        }

        if (dto.components && dto.components.length > 0 && product) {
          await tx.productionComponent.deleteMany({
            where: { productionId: id },
          });

          const componentDetails = await Promise.all(
            dto.components.map(async (c) => {
              const comp = product.comboComponents.find(
                (pc) => pc.componentProductId === c.componentProductId,
              );
              const componentProduct = comp?.componentProduct;
              const weightInGrams =
                componentProduct?.weightUnit === 'kg'
                  ? Number(componentProduct.weight) * 1000
                  : Number(componentProduct?.weight || 0);

              return {
                productionId: id,
                componentProductId: c.componentProductId,
                componentCode: componentProduct?.code || '',
                componentName: componentProduct?.name || '',
                formulaGrams: c.formulaGrams,
                actualGrams: c.actualGrams,
                unitsDeducted:
                  weightInGrams > 0 ? c.actualGrams / weightInGrams : 0,
              };
            }),
          );

          await tx.productionComponent.createMany({ data: componentDetails });
        }
      }

      // Trường hợp 2: Hoàn thành (2) → Hủy (3)
      if (dto.status === 3 && production.status === 2) {
        const product = await tx.product.findUnique({
          where: { id: production.productId },
          include: {
            comboComponents: {
              include: { componentProduct: true },
            },
          },
        });

        if (product && production.autoDeductComponents) {
          await this.reverseInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
            Number(production.quantity),
          );
        }
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });

        const updatedProduction = await tx.production.findUnique({
          where: { id },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PRODUCTION_UPDATE',
          entityType: 'productions',
          entityId: id.toString(),
          entityCode: production.code,
          category: getCategoryFromActionCode('PRODUCTION_UPDATE'),
          severity: getSeverityFromActionCode('PRODUCTION_UPDATE'),
          snapshot: this.buildProductionSnapshot(
            updatedProduction || production,
          ),
          message: renderAuditMessage('PRODUCTION_UPDATE', {
            productionCode: production.code,
          }),
          messageTemplate: 'PRODUCTION_UPDATE',
          userId,
          userName: user?.name || 'System',
          branchId: production.sourceBranchId,
        });
      }

      return tx.production.update({
        where: { id },
        data: updateData,
      });
    });
  }

  async remove(id: number, userId?: number) {
    const production = await this.prisma.production.findUnique({
      where: { id },
    });

    if (!production) {
      throw new NotFoundException(`Production with id ${id} not found`);
    }

    await this.prisma.production.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRODUCTION_DELETE',
        entityType: 'productions',
        entityId: id.toString(),
        entityCode: production.code,
        category: getCategoryFromActionCode('PRODUCTION_DELETE'),
        severity: getSeverityFromActionCode('PRODUCTION_DELETE'),
        snapshot: this.buildProductionSnapshot(production),
        message: renderAuditMessage('PRODUCTION_DELETE', {
          productionCode: production.code,
        }),
        messageTemplate: 'PRODUCTION_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: production.sourceBranchId || undefined,
      });
    }

    return { message: 'Xóa phiếu sản xuất thành công' };
  }

  private async calculateTotalCost(
    components: any[],
    branchId: number,
    quantity: number,
  ): Promise<number> {
    let totalCost = 0;

    for (const comp of components) {
      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: branchId,
          },
        },
      });

      if (inventory) {
        // ─── PIECE MODE ─────────────────────────────────────────────
        if (comp.inputMode === 'piece') {
          const totalPieces = Number(comp.quantity) * Number(quantity);
          totalCost += Number(inventory.cost) * totalPieces;
          continue;
        }
        // ─────────────────────────────────────────────────────────────

        const componentWeight = comp.componentProduct.weight
          ? Number(comp.componentProduct.weight)
          : 0;
        const componentWeightUnit = comp.componentProduct.weightUnit || 'g';
        const weightInGrams =
          componentWeightUnit === 'kg'
            ? componentWeight * 1000
            : componentWeight;

        if (weightInGrams > 0) {
          const requiredGrams = Number(comp.quantity) * Number(quantity);
          const costPerGram = Number(inventory.cost) / weightInGrams;
          totalCost += costPerGram * requiredGrams;
        }
      }
    }

    return totalCost;
  }

  private async processInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
    quantity: number,
    actualComponents?: { componentProductId: number; actualGrams: number }[],
  ) {
    for (const comp of product.comboComponents) {
      const componentProduct = comp.componentProduct;
      const componentWeight = componentProduct.weight
        ? Number(componentProduct.weight)
        : 0;
      const componentWeightUnit = componentProduct.weightUnit || 'g';
      const weightInGrams =
        componentWeightUnit === 'kg' ? componentWeight * 1000 : componentWeight;

      const actual = actualComponents?.find(
        (a) => a.componentProductId === comp.componentProductId,
      );

      // ─── PIECE MODE: trừ kho theo số chiếc trực tiếp ───────────────
      if (comp.inputMode === 'piece') {
        const totalPiecesToDeduct = actual
          ? actual.actualGrams // field này chứa số chiếc thực tế khi piece mode
          : Number(comp.quantity) * Number(quantity);

        const sourceInventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: comp.componentProductId,
              branchId: sourceBranchId,
            },
          },
        });

        if (!sourceInventory) {
          throw new NotFoundException(
            `Inventory for component ${componentProduct.name} not found at source branch`,
          );
        }

        if (Number(sourceInventory.onHand) < totalPiecesToDeduct) {
          throw new BadRequestException(
            `Insufficient inventory for component ${componentProduct.name}. Required: ${totalPiecesToDeduct}, Available: ${sourceInventory.onHand}`,
          );
        }

        const newOnHand = Number(sourceInventory.onHand) - totalPiecesToDeduct;
        const newTotalWeight = newOnHand * weightInGrams;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: comp.componentProductId,
              branchId: sourceBranchId,
            },
          },
          data: { onHand: newOnHand, totalWeight: newTotalWeight },
        });

        await tx.inventoryLog.create({
          data: {
            productId: comp.componentProductId,
            productCode: componentProduct.code,
            productName: componentProduct.name,
            branchId: sourceBranchId,
            branchName: '',
            transactionType: 'PRODUCTION_OUT',
            refCode: '',
            refType: 'production',
            refId: 0,
            quantity: -totalPiecesToDeduct,
            costPrice: Number(sourceInventory.cost),
            transactionPrice: null,
          },
        });
        continue; // ← skip gram logic bên dưới
      }
      // ───────────────────────────────────────────────────────────────

      // GRAM MODE (logic gốc)
      if (weightInGrams === 0) {
        throw new BadRequestException(
          `Component ${componentProduct.name} must have weight defined`,
        );
      }

      const totalGramsToDeduct = actual
        ? actual.actualGrams
        : Number(comp.quantity) * Number(quantity);

      const unitsToDeduct = totalGramsToDeduct / weightInGrams;

      const sourceInventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
      });

      if (!sourceInventory) {
        throw new NotFoundException(
          `Inventory for component ${componentProduct.name} not found at source branch`,
        );
      }

      if (Number(sourceInventory.onHand) < unitsToDeduct) {
        throw new BadRequestException(
          `Insufficient inventory for component ${componentProduct.name}. Required: ${unitsToDeduct}, Available: ${sourceInventory.onHand}`,
        );
      }

      const newOnHand = Number(sourceInventory.onHand) - unitsToDeduct;
      const newTotalWeight = newOnHand * weightInGrams;

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
        data: { onHand: newOnHand, totalWeight: newTotalWeight },
      });

      await tx.inventoryLog.create({
        data: {
          productId: comp.componentProductId,
          productCode: componentProduct.code,
          productName: componentProduct.name,
          branchId: sourceBranchId,
          branchName: '',
          transactionType: 'PRODUCTION_OUT',
          refCode: '',
          refType: 'production',
          refId: 0,
          quantity: -unitsToDeduct,
          costPrice: sourceInventory ? Number(sourceInventory.cost) : 0,
          transactionPrice: null,
        },
      });
    }

    const productWeight = product.weight ? Number(product.weight) : 0;
    const productWeightUnit = product.weightUnit || 'g';
    const productWeightInGrams =
      productWeightUnit === 'kg' ? productWeight * 1000 : productWeight;

    const destInventory = await tx.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
    });

    if (destInventory) {
      const newOnHand = Number(destInventory.onHand) + Number(quantity);
      const newTotalWeight = newOnHand * productWeightInGrams;

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: product.id,
            branchId: destinationBranchId,
          },
        },
        data: {
          onHand: newOnHand,
          totalWeight: newTotalWeight,
        },
      });
    } else {
      const destBranch = await tx.branch.findUnique({
        where: { id: destinationBranchId },
      });

      const totalWeight = Number(quantity) * productWeightInGrams;

      await tx.inventory.create({
        data: {
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          branchId: destinationBranchId,
          branchName: destBranch?.name || '',
          cost: 0,
          onHand: Number(quantity),
          totalWeight: totalWeight,
          reserved: 0,
          onOrder: 0,
          minQuality: 0,
          maxQuality: 0,
        },
      });
    }
  }

  private async reverseInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
    quantity: number,
  ) {
    for (const comp of product.comboComponents) {
      const componentProduct = comp.componentProduct;
      const componentWeight = componentProduct.weight
        ? Number(componentProduct.weight)
        : 0;
      const componentWeightUnit = componentProduct.weightUnit || 'g';
      const weightInGrams =
        componentWeightUnit === 'kg' ? componentWeight * 1000 : componentWeight;

      // ─── PIECE MODE ─────────────────────────────────────────────────
      if (comp.inputMode === 'piece') {
        const totalPiecesToRestore = Number(comp.quantity) * Number(quantity);

        const sourceInventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: comp.componentProductId,
              branchId: sourceBranchId,
            },
          },
        });

        if (!sourceInventory) {
          throw new NotFoundException(
            `Inventory for component ${componentProduct.name} not found at source branch`,
          );
        }

        const newOnHand = Number(sourceInventory.onHand) + totalPiecesToRestore;
        const newTotalWeight = newOnHand * weightInGrams;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: comp.componentProductId,
              branchId: sourceBranchId,
            },
          },
          data: { onHand: newOnHand, totalWeight: newTotalWeight },
        });
        continue; // ← skip gram logic
      }
      // ─────────────────────────────────────────────────────────────────

      // GRAM MODE (logic gốc)
      if (weightInGrams === 0) {
        throw new BadRequestException(
          `Component ${componentProduct.name} must have weight defined`,
        );
      }

      const requiredGrams = Number(comp.quantity) * Number(quantity);
      const unitsToRestore = requiredGrams / weightInGrams;

      const sourceInventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
      });

      if (!sourceInventory) {
        throw new NotFoundException(
          `Inventory for component ${componentProduct.name} not found at source branch`,
        );
      }

      const newOnHand = Number(sourceInventory.onHand) + unitsToRestore;
      const newTotalWeight = newOnHand * weightInGrams;

      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: comp.componentProductId,
            branchId: sourceBranchId,
          },
        },
        data: { onHand: newOnHand, totalWeight: newTotalWeight },
      });
    }

    const productWeight = product.weight ? Number(product.weight) : 0;
    const productWeightUnit = product.weightUnit || 'g';
    const productWeightInGrams =
      productWeightUnit === 'kg' ? productWeight * 1000 : productWeight;

    const destInventory = await tx.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
    });

    if (!destInventory) {
      throw new NotFoundException(
        `Inventory for product ${product.name} not found at destination branch`,
      );
    }

    const newOnHand = Number(destInventory.onHand) - Number(quantity);
    const newTotalWeight = newOnHand * productWeightInGrams;

    await tx.inventory.update({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
      data: {
        onHand: newOnHand,
        totalWeight: newTotalWeight,
      },
    });
  }

  private buildProductionSnapshot(production: any) {
    return {
      code: production.code,
      status: production.status,
      productId: production.productId,
      productCode: production.productCode,
      productName: production.productName,
      quantity: Number(production.quantity),
      totalCost: Number(production.totalCost),
      sourceBranchName: production.sourceBranchName,
      destinationBranchName: production.destinationBranchName,
      note: production.note,
      autoDeductComponents: production.autoDeductComponents,
      manufacturedDate: production.manufacturedDate,
      createdByName: production.createdByName,
    };
  }
}
