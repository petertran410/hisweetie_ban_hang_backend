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
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';

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
    const and: any[] = [];

    if (branchIds && branchIds.length > 0) {
      and.push({
        OR: [
          { sourceBranchId: { in: branchIds } },
          { destinationBranchId: { in: branchIds } },
        ],
      });
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
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { productName: { contains: search, mode: 'insensitive' } },
          { productCode: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (and.length > 0) {
      where.AND = and;
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
          dto.components, // ← actualComponents
          {
            id: production.id,
            code: production.code,
            manufacturedDate: production.manufacturedDate,
          },
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
              // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
              unitsDeducted:
                weightInGrams > 0
                  ? c.actualGrams / weightInGrams
                  : c.actualGrams,
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
              // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
              unitsDeducted:
                weightInGrams > 0
                  ? c.actualGrams / weightInGrams
                  : c.actualGrams,
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
            {
              id: production.id,
              code: production.code,
              manufacturedDate: dto.manufacturedDate
                ? new Date(dto.manufacturedDate)
                : production.manufacturedDate,
            },
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
                // weight=0 (piece/carton): actualGrams chính là số đơn vị/thùng
                unitsDeducted:
                  weightInGrams > 0
                    ? c.actualGrams / weightInGrams
                    : c.actualGrams,
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
          // LOG-TRUTH: đổi status → 3 (CANCELLED) TRƯỚC để active-finder loại
          // toàn bộ log của phiếu (PRODUCTION_OUT/IN, refType='production',
          // status!=3) khỏi Σ, rồi recalc đưa onHand component@source +
          // thành phẩm@dest về Σ log active (tự khôi phục đúng số đã trừ/cộng).
          await tx.production.update({
            where: { id },
            data: { status: 3 },
          });

          await this.reverseInventoryChanges(
            tx,
            product,
            production.sourceBranchId,
            production.destinationBranchId,
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
      include: {
        product: {
          include: {
            comboComponents: { include: { componentProduct: true } },
          },
        },
      },
    });

    if (!production) {
      throw new NotFoundException(`Production with id ${id} not found`);
    }

    // LOG-TRUTH: xóa cứng phiếu trong transaction; log PRODUCTION_OUT/IN trỏ
    // refId này sẽ thành inactive (active-finder không tìm thấy phiếu) → recalc
    // đưa onHand component@source + thành phẩm@dest về Σ log active. Chỉ recalc
    // khi phiếu ĐÃ hoàn thành (status=2) vì chỉ khi đó mới có log để loại.
    await this.prisma.$transaction(async (tx) => {
      await tx.production.delete({ where: { id } });

      if (production.status === 2 && production.product) {
        const affectedPairs: { productId: number; branchId: number }[] = [
          {
            productId: production.productId,
            branchId: production.destinationBranchId,
          },
        ];
        for (const comp of production.product.comboComponents) {
          affectedPairs.push({
            productId: comp.componentProductId,
            branchId: production.sourceBranchId,
          });
        }
        await recalcOnHandForPairs(tx, affectedPairs);
      }
    });

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
        // ─── PIECE / CARTON MODE ────────────────────────────────────
        // Cả hai mode tính cost theo đơn vị: cost/đơn-vị × tổng-đơn-vị.
        // CARTON: comp.quantity = 1/N (N = sức chứa) → mỗi thành phẩm gánh
        // cost-thùng/N; nhân quantity sản xuất ra tổng số thùng tiêu hao.
        if (comp.inputMode === 'piece' || comp.inputMode === 'carton') {
          const totalUnits = Number(comp.quantity) * Number(quantity);
          totalCost += Number(inventory.cost) * totalUnits;
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
    production?: { id: number; code: string; manufacturedDate?: Date | null },
  ) {
    // refCode/refId neo log về chính phiếu sản xuất → active-finder
    // (status != 3) loại log khi phiếu bị hủy/xóa. transactionDate neo theo
    // manufacturedDate để phiếu lùi ngày đứng đúng vị trí trên thẻ kho.
    const refCode = production?.code || '';
    const refId = production?.id || 0;
    const transactionDate = production?.manufacturedDate || new Date();

    // Gom các cặp (productId, branchId) bị tác động để recalc cuối hàm.
    const affectedPairs: { productId: number; branchId: number }[] = [];

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

      // PIECE-LIKE: trừ kho theo số đơn vị trực tiếp. Áp dụng cho
      // inputMode='piece', inputMode='carton' (thùng — quantity=1/N), LẪN
      // trường hợp component không có weight (weightInGrams===0) — tránh
      // chia 0 / throw oan ở nhánh gram.
      // CARTON: comp.quantity = 1/N → comp.quantity × quantity = số thùng
      // tiêu hao (phân số, KHÔNG làm tròn để các đợt cộng dồn khít nhau).
      const isPieceLike =
        comp.inputMode === 'piece' ||
        comp.inputMode === 'carton' ||
        weightInGrams === 0;

      const unitsToDeduct = isPieceLike
        ? actual
          ? actual.actualGrams // field này chứa số đơn vị thực tế khi piece/carton
          : Number(comp.quantity) * Number(quantity)
        : (actual
            ? actual.actualGrams
            : Number(comp.quantity) * Number(quantity)) / weightInGrams;

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

      await tx.inventoryLog.create({
        data: {
          productId: comp.componentProductId,
          productCode: componentProduct.code,
          productName: componentProduct.name,
          branchId: sourceBranchId,
          branchName: sourceInventory.branchName || '',
          transactionType: 'PRODUCTION_OUT',
          refCode,
          refType: 'production',
          refId,
          quantity: -unitsToDeduct,
          costPrice: Number(sourceInventory.cost),
          transactionPrice: null,
          transactionDate,
        },
      });

      affectedPairs.push({
        productId: comp.componentProductId,
        branchId: sourceBranchId,
      });
    }

    // ─── Thành phẩm nhập kho đích: ghi log PRODUCTION_IN ──────────────────
    const destInventory = await tx.inventory.findUnique({
      where: {
        productId_branchId: {
          productId: product.id,
          branchId: destinationBranchId,
        },
      },
    });

    if (!destInventory) {
      // Khởi tạo bản ghi tồn (onHand=0) — giá trị thật sẽ do recalc set lại
      // theo Σ log active. Tạo trước để recalc có chỗ ghi.
      const destBranch = await tx.branch.findUnique({
        where: { id: destinationBranchId },
      });
      await tx.inventory.create({
        data: {
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          branchId: destinationBranchId,
          branchName: destBranch?.name || '',
          cost: 0,
          onHand: 0,
          totalWeight: 0,
          reserved: 0,
          onOrder: 0,
          minQuality: 0,
          maxQuality: 0,
        },
      });
    }

    await tx.inventoryLog.create({
      data: {
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        branchId: destinationBranchId,
        branchName: destInventory?.branchName || '',
        transactionType: 'PRODUCTION_IN',
        refCode,
        refType: 'production',
        refId,
        quantity: Number(quantity),
        costPrice: destInventory ? Number(destInventory.cost) : 0,
        transactionPrice: null,
        transactionDate,
      },
    });

    affectedPairs.push({
      productId: product.id,
      branchId: destinationBranchId,
    });

    // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi đã ghi mọi log
    // PRODUCTION_OUT/IN, recalc lại onHand từ thẻ kho.
    await recalcOnHandForPairs(tx, affectedPairs);
  }

  // LOG-TRUTH: phiếu đã được set status=3 (CANCELLED) TRƯỚC khi gọi hàm này,
  // nên active-finder (status!=3) tự loại mọi log PRODUCTION_OUT/IN của phiếu
  // khỏi Σ. Chỉ cần recalc onHand cho component@source + thành phẩm@dest →
  // tự khôi phục đúng số đã trừ/cộng (KHÔNG cộng/trừ tay, KHÔNG ghi log đối ứng).
  private async reverseInventoryChanges(
    tx: any,
    product: any,
    sourceBranchId: number,
    destinationBranchId: number,
  ) {
    const affectedPairs: { productId: number; branchId: number }[] = [
      { productId: product.id, branchId: destinationBranchId },
    ];
    for (const comp of product.comboComponents) {
      affectedPairs.push({
        productId: comp.componentProductId,
        branchId: sourceBranchId,
      });
    }
    await recalcOnHandForPairs(tx, affectedPairs);
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
