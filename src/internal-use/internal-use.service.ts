import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInternalUseDto,
  UpdateInternalUseDto,
  InternalUseQueryDto,
  CancelInternalUseDto,
  CreatePurposeDto,
  UpdatePurposeDto,
} from './dto';
import { Prisma } from '@prisma/client';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from '../audit-logs/audit-templates';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';

@Injectable()
export class InternalUseService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAllPurposes() {
    return this.prisma.internalUsePurpose.findMany({
      where: { isDeleted: false },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
  }

  async createPurpose(dto: CreatePurposeDto) {
    return this.prisma.internalUsePurpose.create({
      data: { name: dto.name, order: dto.order ?? 999 },
    });
  }

  async updatePurpose(id: number, dto: UpdatePurposeDto) {
    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id },
    });
    if (!purpose || purpose.isDeleted) {
      throw new NotFoundException(`InternalUsePurpose with ID ${id} not found`);
    }
    return this.prisma.internalUsePurpose.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
      },
    });
  }

  async deletePurpose(id: number) {
    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id },
    });
    if (!purpose || purpose.isDeleted) {
      throw new NotFoundException(`InternalUsePurpose with ID ${id} not found`);
    }
    await this.prisma.internalUsePurpose.update({
      where: { id },
      data: { isDeleted: true },
    });
    return { message: 'Purpose deleted successfully' };
  }

  async findAll(query: InternalUseQueryDto) {
    const {
      branchIds,
      status,
      pageSize = 15,
      currentItem = 0,
      fromDate,
      toDate,
      search,
      createdById,
      userId,
      purposeId,
    } = query;

    const where: Prisma.InternalUseWhereInput = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (createdById) {
      where.createdById = createdById;
    }

    if (userId) {
      where.userId = userId;
    }

    if (purposeId) {
      where.purposeId = purposeId;
    }

    if (search) {
      where.code = { contains: search, mode: 'insensitive' };
    }

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = new Date(fromDate);
      }
      if (toDate) {
        where.createdAt.lte = new Date(toDate);
      }
    }

    const [data, total, agg] = await Promise.all([
      this.prisma.internalUse.findMany({
        where,
        include: {
          details: { include: { product: true } },
          purpose: true,
          branch: true,
          user: true,
          creator: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: pageSize,
      }),
      this.prisma.internalUse.count({ where }),
      this.prisma.internalUse.aggregate({ where, _sum: { totalValue: true } }),
    ]);

    return {
      data,
      total,
      pageSize,
      totalValue: Number(agg._sum.totalValue || 0),
    };
  }

  async findOne(id: number) {
    const internalUse = await this.prisma.internalUse.findUnique({
      where: { id },
      include: {
        details: { include: { product: true } },
        purpose: true,
        branch: true,
        user: true,
        creator: true,
      },
    });

    if (!internalUse) {
      throw new NotFoundException(`InternalUse with ID ${id} not found`);
    }

    return internalUse;
  }

  async create(dto: CreateInternalUseDto, userId: number) {
    const creator = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
    });

    if (!branch) {
      throw new NotFoundException(`Branch with ID ${dto.branchId} not found`);
    }

    const purpose = await this.prisma.internalUsePurpose.findUnique({
      where: { id: dto.purposeId },
    });
    if (!purpose) {
      throw new NotFoundException(
        `InternalUsePurpose with ID ${dto.purposeId} not found`,
      );
    }

    const isDraft = dto.isDraft ?? true;

    this.validateDetails(dto.internalUseDetails, isDraft);

    let usedUser: { name: string } | null = null;
    if (dto.userId) {
      usedUser = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { name: true },
      });
    }

    const code = await this.resolveCode(dto.code);
    const status = isDraft ? 1 : 2;
    const transDate = isDraft ? null : new Date();

    // Resolve giá vốn cho từng dòng: nếu client không gửi cost (user không có
    // quyền xem giá vốn) thì tự lấy từ inventory theo (product, branch).
    const resolvedDetails = await this.resolveDetailCosts(
      dto.internalUseDetails,
      dto.branchId,
    );

    let totalValue = 0;
    for (const detail of resolvedDetails) {
      totalValue += Number(detail.quantity) * Number(detail.cost);
    }

    const internalUse = await this.prisma.$transaction(async (tx) => {
      const created = await tx.internalUse.create({
        data: {
          code,
          branchId: dto.branchId,
          branchName: branch.name,
          status,
          transDate,
          purposeId: dto.purposeId,
          userId: dto.userId ?? null,
          userName: usedUser?.name ?? null,
          createdById: userId,
          createdByName: creator?.name || 'Unknown',
          description: dto.description,
          totalValue,
          details: {
            create: resolvedDetails.map((detail) => ({
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName || '',
              unit: detail.unit,
              quantity: detail.quantity,
              cost: detail.cost,
              value: Number(detail.quantity) * Number(detail.cost),
            })),
          },
        },
        include: { details: true },
      });

      if (!isDraft) {
        await this.decrementInventory(created.id, tx);
      }

      return created;
    });

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'INTERNAL_USE_CREATE',
      entityType: 'internal_uses',
      entityId: internalUse.id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_CREATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_CREATE'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_CREATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_CREATE',
      userId,
      userName: creator?.name || creator?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return internalUse;
  }

  async update(id: number, dto: UpdateInternalUseDto, userId: number) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException(
        'Cannot update cancelled internal use voucher',
      );
    }

    if (internalUse.status === 2) {
      throw new BadRequestException(
        'Cannot update completed internal use voucher',
      );
    }

    const updateData: Prisma.InternalUseUpdateInput = {};

    if (dto.description !== undefined) {
      updateData.description = dto.description;
    }

    if (dto.purposeId !== undefined) {
      const purpose = await this.prisma.internalUsePurpose.findUnique({
        where: { id: dto.purposeId },
      });
      if (!purpose) {
        throw new NotFoundException(
          `InternalUsePurpose with ID ${dto.purposeId} not found`,
        );
      }
      updateData.purpose = { connect: { id: dto.purposeId } };
    }

    if (dto.userId !== undefined) {
      if (dto.userId === null) {
        updateData.user = { disconnect: true };
        updateData.userName = null;
      } else {
        const usedUser = await this.prisma.user.findUnique({
          where: { id: dto.userId },
          select: { name: true },
        });
        if (!usedUser) {
          throw new NotFoundException(`User with ID ${dto.userId} not found`);
        }
        updateData.user = { connect: { id: dto.userId } };
        updateData.userName = usedUser.name;
      }
    }

    if (dto.createdById !== undefined) {
      const creator = await this.prisma.user.findUnique({
        where: { id: dto.createdById },
      });
      if (!creator) {
        throw new NotFoundException(
          `User with ID ${dto.createdById} not found`,
        );
      }
      updateData.creator = { connect: { id: dto.createdById } };
      updateData.createdByName = creator.name;
    }

    if (dto.transDate !== undefined) {
      updateData.transDate = dto.transDate ? new Date(dto.transDate) : null;
    }

    const willComplete = dto.status === 2 || dto.isDraft === false;
    if (willComplete) {
      const details = dto.internalUseDetails ?? internalUse.details;
      this.validateDetails(details, false);
      updateData.status = 2;
      updateData.transDate = updateData.transDate ?? new Date();
    } else if (dto.status !== undefined) {
      updateData.status = dto.status;
    }

    const branchIdForCost = internalUse.branchId;
    const resolvedDetails = dto.internalUseDetails
      ? await this.resolveDetailCosts(dto.internalUseDetails, branchIdForCost)
      : null;

    if (resolvedDetails) {
      let totalValue = 0;
      for (const detail of resolvedDetails) {
        totalValue += Number(detail.quantity) * Number(detail.cost);
      }
      updateData.totalValue = totalValue;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (resolvedDetails) {
        await tx.internalUseDetail.deleteMany({
          where: { internalUseId: id },
        });
        await tx.internalUseDetail.createMany({
          data: resolvedDetails.map((detail) => ({
            internalUseId: id,
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName || '',
            unit: detail.unit,
            quantity: detail.quantity,
            cost: detail.cost,
            value: Number(detail.quantity) * Number(detail.cost),
          })),
        });
      }

      const result = await tx.internalUse.update({
        where: { id },
        data: updateData,
        include: { details: true },
      });

      if (internalUse.status === 1 && willComplete) {
        await this.decrementInventory(id, tx);
      }

      return result;
    });

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_UPDATE',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_UPDATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_UPDATE'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_UPDATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_UPDATE',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return updated;
  }

  async complete(id: number, userId: number) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException(
        'Cannot complete cancelled internal use voucher',
      );
    }
    if (internalUse.status === 2) {
      throw new BadRequestException('Internal use voucher already completed');
    }

    this.validateDetails(internalUse.details, false);

    const completed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.internalUse.update({
        where: { id },
        data: { status: 2, transDate: internalUse.transDate ?? new Date() },
        include: { details: true },
      });
      await this.decrementInventory(id, tx);
      return result;
    });

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_UPDATE',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_UPDATE'),
      severity: getSeverityFromActionCode('INTERNAL_USE_UPDATE'),
      snapshot: this.buildSnapshot(completed),
      message: renderAuditMessage('INTERNAL_USE_UPDATE', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_UPDATE',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return completed;
  }

  async cancel(id: number, dto: CancelInternalUseDto, userId: number) {
    const internalUse = await this.findOne(id);

    if (internalUse.status === 3) {
      throw new BadRequestException('Internal use voucher already cancelled');
    }

    const description = dto.cancelReason
      ? `${internalUse.description ? internalUse.description + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
      : internalUse.description;

    if (internalUse.status === 1) {
      await this.prisma.internalUse.update({
        where: { id },
        data: { status: 3, description },
      });
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.internalUse.update({
          where: { id },
          data: { status: 3, description },
        });

        for (const detail of internalUse.details) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: internalUse.branchId,
              },
            },
            data: { onHand: { increment: detail.quantity } },
          });
        }

        // Xóa các dòng thẻ kho gốc của phiếu (transactionType INTERNAL_USE)
        // — không để lại dấu vết trên thẻ kho sản phẩm sau khi hủy.
        await tx.inventoryLog.deleteMany({
          where: { refType: 'internal_use', refId: internalUse.id },
        });

        // NGUỒN CHÂN LÝ: sau khi xóa log INTERNAL_USE, recalc onHand = Σ log
        // active (loại hẳn phần đã xuất của phiếu vừa hủy).
        await recalcOnHandForPairs(
          tx,
          internalUse.details.map((detail: any) => ({
            productId: detail.productId,
            branchId: internalUse.branchId,
          })),
        );
      });
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    await this.auditLogsService.create({
      actionType: 'PUT',
      actionCode: 'INTERNAL_USE_CANCEL',
      entityType: 'internal_uses',
      entityId: id.toString(),
      entityCode: internalUse.code,
      category: getCategoryFromActionCode('INTERNAL_USE_CANCEL'),
      severity: getSeverityFromActionCode('INTERNAL_USE_CANCEL'),
      snapshot: this.buildSnapshot(internalUse),
      message: renderAuditMessage('INTERNAL_USE_CANCEL', {
        internalUseCode: internalUse.code,
      }),
      messageTemplate: 'INTERNAL_USE_CANCEL',
      userId,
      userName: actor?.name || actor?.email || 'System',
      branchId: internalUse.branchId || undefined,
    });

    return { message: 'Internal use voucher cancelled successfully' };
  }

  private validateDetails(
    details: { quantity: number | Prisma.Decimal }[] | undefined,
    requireComplete: boolean,
  ) {
    if (!requireComplete) return;

    if (!details || details.length === 0) {
      throw new BadRequestException(
        'Phiếu phải có ít nhất một dòng sản phẩm để hoàn thành',
      );
    }
    for (const detail of details) {
      if (Number(detail.quantity) <= 0) {
        throw new BadRequestException(
          'Số lượng xuất phải lớn hơn 0 để hoàn thành phiếu',
        );
      }
    }
  }

  private async resolveDetailCosts<
    T extends { productId: number; quantity: number | string; cost?: number },
  >(details: T[], branchId: number): Promise<(T & { cost: number })[]> {
    return Promise.all(
      details.map(async (detail) => {
        if (detail.cost !== undefined && detail.cost !== null) {
          return { ...detail, cost: Number(detail.cost) };
        }
        const inventory = await this.prisma.inventory.findUnique({
          where: {
            productId_branchId: { productId: detail.productId, branchId },
          },
          select: { cost: true },
        });
        return { ...detail, cost: inventory ? Number(inventory.cost) : 0 };
      }),
    );
  }

  private async resolveCode(inputCode?: string): Promise<string> {
    const code = inputCode?.trim();
    if (code) {
      const existing = await this.prisma.internalUse.findUnique({
        where: { code },
      });
      if (existing) {
        throw new BadRequestException(`Mã phiếu "${code}" đã tồn tại`);
      }
      return code;
    }
    return this.generateCode();
  }

  private async generateCode(): Promise<string> {
    const prefix = 'XDNB';

    const last = await this.prisma.internalUse.findFirst({
      where: { code: { startsWith: `${prefix}` } },
      orderBy: { code: 'desc' },
    });

    let sequence = 1;
    if (last) {
      const lastSequence = parseInt(last.code.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${sequence.toString().padStart(6, '0')}`;
  }

  private async decrementInventory(internalUseId: number, tx: any) {
    const internalUse = await tx.internalUse.findUnique({
      where: { id: internalUseId },
      include: { details: true },
    });

    for (const detail of internalUse.details) {
      const inventory = await tx.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: internalUse.branchId,
          },
        },
        include: {
          product: { select: { weight: true, weightUnit: true } },
        },
      });

      const costPrice = inventory
        ? Number(inventory.cost)
        : Number(detail.cost);

      if (inventory) {
        const newOnHand = Number(inventory.onHand) - Number(detail.quantity);
        const weight = inventory.product.weight
          ? Number(inventory.product.weight)
          : 0;
        const weightUnit = inventory.product.weightUnit || 'g';
        const weightInGrams = weightUnit === 'kg' ? weight * 1000 : weight;
        const totalWeight = weightInGrams * newOnHand;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: internalUse.branchId,
            },
          },
          data: {
            onHand: { decrement: detail.quantity },
            totalWeight,
          },
        });
      }

      await tx.inventoryLog.create({
        data: {
          productId: detail.productId,
          productCode: detail.productCode,
          productName: detail.productName,
          branchId: internalUse.branchId,
          branchName: internalUse.branchName,
          transactionType: 'INTERNAL_USE',
          refCode: internalUse.code,
          refType: 'internal_use',
          refId: internalUse.id,
          quantity: -Number(detail.quantity),
          costPrice,
          transactionPrice: null,
          partnerName: null,
        },
      });
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active. Sau khi ghi log INTERNAL_USE
    // cho mọi dòng, recalc lại onHand từ thẻ kho.
    await recalcOnHandForPairs(
      tx,
      internalUse.details.map((detail: any) => ({
        productId: detail.productId,
        branchId: internalUse.branchId,
      })),
    );
  }

  private buildSnapshot(d: any) {
    return {
      code: d.code,
      branchId: d.branchId,
      status: d.status,
      purposeId: d.purposeId,
      userId: d.userId,
      totalValue: Number(d.totalValue || 0),
      transDate: d.transDate,
      description: d.description,
      details: (d.details || []).map((item: any) => ({
        productId: item.productId,
        productCode: item.productCode,
        productName: item.productName,
        quantity: Number(item.quantity),
        cost: Number(item.cost),
        value: Number(item.value),
      })),
    };
  }
}
