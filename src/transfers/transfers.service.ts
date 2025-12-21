import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateTransferDto,
  UpdateTransferDto,
  TransferQueryDto,
  CancelTransferDto,
} from './dto';

@Injectable()
export class TransfersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: TransferQueryDto) {
    const {
      fromBranchIds,
      toBranchIds,
      currentBranchId,
      status,
      pageSize = 20,
      currentItem = 0,
      fromReceivedDate,
      toReceivedDate,
      fromTransferDate,
      toTransferDate,
    } = query;

    const where: any = {};

    if (currentBranchId) {
      const baseConditions: any[] = [
        { fromBranchId: currentBranchId },
        {
          toBranchId: currentBranchId,
          status: { gte: 2 },
        },
      ];

      if (fromBranchIds && fromBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ fromBranchId: { in: fromBranchIds } }],
          },
        ];
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.OR = [
          {
            fromBranchId: currentBranchId,
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
          {
            toBranchId: currentBranchId,
            status: { gte: 2 },
            AND: [{ toBranchId: { in: toBranchIds } }],
          },
        ];
      } else {
        where.OR = baseConditions;
      }
    } else {
      if (
        fromBranchIds &&
        fromBranchIds.length > 0 &&
        toBranchIds &&
        toBranchIds.length > 0
      ) {
        where.AND = [
          { fromBranchId: { in: fromBranchIds } },
          { toBranchId: { in: toBranchIds } },
          { status: { gte: 2 } },
        ];
      } else if (fromBranchIds && fromBranchIds.length > 0) {
        where.fromBranchId = { in: fromBranchIds };
      } else if (toBranchIds && toBranchIds.length > 0) {
        where.toBranchId = { in: toBranchIds };
        where.status = { gte: 2 };
      }
    }

    if (status && status.length > 0) {
      if (where.OR) {
        where.OR = where.OR.map((condition: any) => {
          if (condition.status && condition.status.gte) {
            return {
              ...condition,
              status: {
                in: status.filter((s) => s >= 2),
              },
            };
          }
          return {
            ...condition,
            status: { in: status },
          };
        });
      } else if (where.AND) {
        where.AND = where.AND.map((condition: any) => {
          if (condition.status) {
            return { status: { in: status } };
          }
          return condition;
        });
      } else {
        where.status = { in: status };
      }
    }

    if (fromReceivedDate || toReceivedDate) {
      where.receivedDate = {};
      if (fromReceivedDate) {
        where.receivedDate.gte = new Date(fromReceivedDate);
      }
      if (toReceivedDate) {
        where.receivedDate.lte = new Date(toReceivedDate);
      }
    }

    if (fromTransferDate || toTransferDate) {
      where.transferredDate = {};
      if (fromTransferDate) {
        where.transferredDate.gte = new Date(fromTransferDate);
      }
      if (toTransferDate) {
        where.transferredDate.lte = new Date(toTransferDate);
      }
    }

    const [total, data] = await Promise.all([
      this.prisma.transfer.count({ where }),
      this.prisma.transfer.findMany({
        where,
        skip: currentItem,
        take: Math.min(pageSize, 100),
        include: {
          fromBranch: {
            select: {
              id: true,
              name: true,
            },
          },
          toBranch: {
            select: {
              id: true,
              name: true,
            },
          },
          creator: {
            select: {
              id: true,
              name: true,
            },
          },
          details: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  unit: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formattedData = data.map((transfer) => ({
      id: transfer.id,
      code: transfer.code,
      fromBranchId: transfer.fromBranchId,
      fromBranchName: transfer.fromBranch?.name || '',
      toBranchId: transfer.toBranchId,
      toBranchName: transfer.toBranch?.name || '',
      status: transfer.status,
      totalTransfer: Number(transfer.totalTransfer) || 0,
      totalReceive: Number(transfer.totalReceive) || 0,
      noteBySource: transfer.noteBySource || '',
      noteByDestination: transfer.noteByDestination || '',
      transferredDate: transfer.transferredDate,
      receivedDate: transfer.receivedDate,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      createdById: transfer.createdById,
      createdByName: transfer.creator?.name || '',
      details: transfer.details.map((detail) => ({
        id: detail.id,
        productId: detail.productId,
        productCode: detail.productCode,
        productName: detail.productName,
        sendQuantity: Number(detail.sendQuantity),
        receivedQuantity: Number(detail.receivedQuantity),
        sendPrice: Number(detail.sendPrice),
        receivePrice: Number(detail.receivePrice),
      })),
    }));

    return {
      total,
      pageSize: Math.min(pageSize, 100),
      currentItem,
      data: formattedData,
    };
  }

  async findOne(id: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id },
      include: {
        fromBranch: true,
        toBranch: true,
        creator: true,
        details: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer with ID ${id} not found`);
    }

    return transfer;
  }

  async create(dto: CreateTransferDto, userId: number) {
    const [fromBranch, toBranch, user] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: dto.fromBranchId } }),
      this.prisma.branch.findUnique({ where: { id: dto.toBranchId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);

    if (!fromBranch) {
      throw new NotFoundException(
        `Chi nhánh với ID ${dto.fromBranchId} không tồn tại`,
      );
    }
    if (!toBranch) {
      throw new NotFoundException(
        `Chi nhánh với ID ${dto.toBranchId} không tồn tại`,
      );
    }
    if (!user) {
      throw new NotFoundException(`Người dùng với ID ${userId} không tồn tại`);
    }

    const code = dto.code || (await this.generateTransferCode());

    const totalTransfer = dto.transferDetails.reduce(
      (sum: number, item: { sendQuantity: number; price: number }) => {
        return sum + item.sendQuantity * item.price;
      },
      0,
    );

    const productIds = dto.transferDetails.map(
      (d: { productId: any }) => d.productId,
    );
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });

    const productMap = new Map(products.map((p) => [p.id, p.name]));

    const transfer = await this.prisma.transfer.create({
      data: {
        code,
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        fromBranchName: fromBranch.name,
        toBranchName: toBranch.name,
        createdById: userId,
        createdByName: user.name,
        status: dto.status || 1,
        noteBySource: dto.description,
        totalTransfer,
        transferredDate: dto.isDraft ? null : new Date(),
        details: {
          create: dto.transferDetails.map((item) => ({
            productId: item.productId,
            productCode: item.productCode,
            productName: productMap.get(item.productId) || '',
            sendQuantity: item.sendQuantity,
            receivedQuantity: item.receivedQuantity || 0,
            sendPrice: item.price,
            receivePrice: item.price,
            totalTransfer: item.sendQuantity * item.price,
            totalReceive: (item.receivedQuantity || 0) * item.price,
          })),
        },
      },
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
        creator: true,
      },
    });

    if (!dto.isDraft) {
      await this.updateInventoryOnTransfer(transfer.id);
    }

    return transfer;
  }

  async update(id: number, dto: UpdateTransferDto) {
    await this.findOne(id);

    const totalTransfer =
      dto.transferDetails?.reduce((sum, item) => {
        return sum + item.sendQuantity * item.price;
      }, 0) || 0;

    const totalReceive =
      dto.transferDetails?.reduce((sum, item) => {
        const receivedQty = item.receivedQuantity || 0;
        return sum + receivedQty * item.price;
      }, 0) || 0;

    const productIds = dto.transferDetails?.map((d) => d.productId) || [];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });

    const productMap = new Map(products.map((p) => [p.id, p.name]));

    const updatedTransfer = await this.prisma.transfer.update({
      where: { id },
      data: {
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        status: dto.status,
        noteBySource: dto.description,
        totalTransfer,
        totalReceive,
        receivedDate: dto.status === 3 ? new Date() : null,
        details: {
          deleteMany: {},
          create:
            dto.transferDetails?.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: productMap.get(item.productId) || '',
              sendQuantity: item.sendQuantity,
              receivedQuantity: item.receivedQuantity || 0,
              sendPrice: item.price,
              receivePrice: item.price,
              totalTransfer: item.sendQuantity * item.price,
              totalReceive: (item.receivedQuantity || 0) * item.price,
            })) || [],
        },
      },
      include: {
        details: true,
      },
    });

    if (dto.status === 3) {
      await this.updateInventoryOnReceive(id);
    }

    return updatedTransfer;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.transfer.delete({ where: { id } });
    return { message: 'Xóa dữ liệu thành công' };
  }

  private async generateTransferCode(): Promise<string> {
    const prefix = 'TRF';
    const count = await this.prisma.transfer.count();
    return `${prefix}${String(count + 1).padStart(6, '0')}`;
  }

  private async updateInventoryOnTransfer(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: { details: true },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      await this.prisma.inventory.updateMany({
        where: {
          productId: detail.productId,
          branchId: transfer.fromBranchId,
        },
        data: {
          onHand: { decrement: detail.sendQuantity },
        },
      });

      await this.prisma.inventory.updateMany({
        where: {
          productId: detail.productId,
          branchId: transfer.toBranchId,
        },
        data: {
          onHand: { increment: detail.receivedQuantity },
        },
      });
    }
  }

  private async updateInventoryOnReceive(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: { details: true },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      await this.prisma.inventory.updateMany({
        where: {
          productId: detail.productId,
          branchId: transfer.fromBranchId,
        },
        data: {
          onHand: { decrement: detail.sendQuantity },
        },
      });

      await this.prisma.inventory.updateMany({
        where: {
          productId: detail.productId,
          branchId: transfer.toBranchId,
        },
        data: {
          onHand: { increment: detail.receivedQuantity },
        },
      });
    }
  }

  async cancelTransfer(id: number, dto: CancelTransferDto) {
    const transfer = await this.findOne(id);

    if (transfer.status === 4) {
      throw new BadRequestException('Phiếu chuyển hàng đã bị hủy');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.transfer.update({
        where: { id },
        data: {
          status: 4,
          noteBySource: dto.cancelReason
            ? `${transfer.noteBySource ? transfer.noteBySource + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : transfer.noteBySource,
        },
      });

      if (transfer.status === 2) {
        for (const detail of transfer.details) {
          await tx.inventory.updateMany({
            where: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });
        }
      }

      if (transfer.status === 3) {
        for (const detail of transfer.details) {
          await tx.inventory.updateMany({
            where: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });

          await tx.inventory.updateMany({
            where: {
              productId: detail.productId,
              branchId: transfer.toBranchId,
            },
            data: {
              onHand: { decrement: detail.receivedQuantity },
            },
          });
        }
      }
    });

    return { message: 'Hủy phiếu chuyển hàng thành công' };
  }
}
