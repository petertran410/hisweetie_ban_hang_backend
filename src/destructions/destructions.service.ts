import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDestructionDto,
  UpdateDestructionDto,
  DestructionQueryDto,
  CancelDestructionDto,
} from './dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class DestructionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: DestructionQueryDto) {
    const {
      branchIds,
      status,
      pageSize = 15,
      currentItem = 0,
      fromDestructionDate,
      toDestructionDate,
    } = query;

    const where: Prisma.DestructionWhereInput = {};

    if (branchIds && branchIds.length > 0) {
      where.branchId = { in: branchIds };
    }

    if (status && status.length > 0) {
      where.status = { in: status };
    }

    if (fromDestructionDate || toDestructionDate) {
      where.destructionDate = {};
      if (fromDestructionDate) {
        where.destructionDate.gte = new Date(fromDestructionDate);
      }
      if (toDestructionDate) {
        where.destructionDate.lte = new Date(toDestructionDate);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.destruction.findMany({
        where,
        include: {
          details: {
            include: { product: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: currentItem,
        take: pageSize,
      }),
      this.prisma.destruction.count({ where }),
    ]);

    return { data, total, pageSize };
  }

  async findOne(id: number) {
    const destruction = await this.prisma.destruction.findUnique({
      where: { id },
      include: {
        details: {
          include: { product: true },
        },
        branch: true,
        creator: true,
      },
    });

    if (!destruction) {
      throw new NotFoundException(`Destruction with ID ${id} not found`);
    }

    return destruction;
  }

  async create(dto: CreateDestructionDto, userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
    });

    if (!branch) {
      throw new NotFoundException(`Branch with ID ${dto.branchId} not found`);
    }

    const code = await this.generateCode();
    const isDraft = dto.isDraft ?? true;
    const status = isDraft ? 1 : 2;
    const destructionDate = isDraft ? null : new Date();

    let totalValue = 0;
    for (const detail of dto.destructionDetails) {
      totalValue += Number(detail.quantity) * Number(detail.price);
    }

    return this.prisma.$transaction(async (tx) => {
      const destruction = await tx.destruction.create({
        data: {
          code,
          branchId: dto.branchId,
          branchName: branch.name,
          status,
          destructionDate,
          createdById: userId,
          createdByName: user?.name || 'Unknown',
          note: dto.note,
          totalValue,
          details: {
            create: dto.destructionDetails.map((detail) => {
              const product = detail as any;
              return {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: product.productName || '',
                quantity: detail.quantity,
                price: detail.price,
                totalValue: Number(detail.quantity) * Number(detail.price),
                note: product.note,
              };
            }),
          },
        },
        include: { details: true },
      });

      if (!isDraft) {
        await this.decrementInventory(destruction.id, tx);
      }

      return destruction;
    });
  }

  async update(id: number, dto: UpdateDestructionDto) {
    const destruction = await this.findOne(id);

    if (destruction.status === 4) {
      throw new BadRequestException('Cannot update cancelled destruction');
    }

    if (destruction.status === 2) {
      throw new BadRequestException('Cannot update completed destruction');
    }

    const updateData: any = {};

    if (dto.note !== undefined) {
      updateData.note = dto.note;
    }

    if (dto.status !== undefined) {
      updateData.status = dto.status;
      if (dto.status === 2) {
        updateData.destructionDate = new Date();
      }
    }

    if (dto.destructionDetails) {
      let totalValue = 0;
      for (const detail of dto.destructionDetails) {
        totalValue += Number(detail.quantity) * Number(detail.price);
      }
      updateData.totalValue = totalValue;
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.destructionDetails) {
        await tx.destructionDetail.deleteMany({ where: { destructionId: id } });
        await tx.destructionDetail.createMany({
          data: dto.destructionDetails.map((detail) => {
            const product = detail as any;
            return {
              destructionId: id,
              productId: detail.productId,
              productCode: detail.productCode,
              productName: product.productName || '',
              quantity: detail.quantity,
              price: detail.price,
              totalValue: Number(detail.quantity) * Number(detail.price),
              note: product.note,
            };
          }),
        });
      }

      const updated = await tx.destruction.update({
        where: { id },
        data: updateData,
        include: { details: true },
      });

      if (destruction.status === 1 && dto.status === 2) {
        await this.decrementInventory(id, tx);
      }

      return updated;
    });
  }

  async remove(id: number) {
    const destruction = await this.findOne(id);

    if (destruction.status === 2) {
      throw new BadRequestException(
        'Cannot delete completed destruction. Please cancel it first.',
      );
    }

    await this.prisma.destruction.delete({ where: { id } });
    return { message: 'Destruction deleted successfully' };
  }

  async cancelDestruction(id: number, dto: CancelDestructionDto) {
    const destruction = await this.findOne(id);

    if (destruction.status === 4) {
      throw new BadRequestException('Destruction already cancelled');
    }

    if (destruction.status === 1) {
      await this.prisma.destruction.update({
        where: { id },
        data: {
          status: 4,
          note: dto.cancelReason
            ? `${destruction.note ? destruction.note + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : destruction.note,
        },
      });
      return { message: 'Destruction cancelled successfully' };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.destruction.update({
        where: { id },
        data: {
          status: 4,
          note: dto.cancelReason
            ? `${destruction.note ? destruction.note + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : destruction.note,
        },
      });

      if (destruction.status === 2) {
        for (const detail of destruction.details) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: destruction.branchId,
              },
            },
            data: {
              onHand: { increment: detail.quantity },
            },
          });
        }
      }
    });

    return { message: 'Destruction cancelled successfully' };
  }

  private async generateCode(): Promise<string> {
    const prefix = 'XH';

    const lastDestruction = await this.prisma.destruction.findFirst({
      where: { code: { startsWith: `${prefix}` } },
      orderBy: { code: 'desc' },
    });

    let sequence = 1;
    if (lastDestruction) {
      const lastSequence = parseInt(lastDestruction.code.slice(-6));
      sequence = lastSequence + 1;
    }

    return `${prefix}${sequence.toString().padStart(6, '0')}`;
  }

  private async decrementInventory(destructionId: number, tx: any) {
    const destruction = await tx.destruction.findUnique({
      where: { id: destructionId },
      include: { details: true },
    });

    for (const detail of destruction.details) {
      await tx.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: destruction.branchId,
          },
        },
        data: {
          onHand: { decrement: detail.quantity },
        },
      });
    }
  }
}
