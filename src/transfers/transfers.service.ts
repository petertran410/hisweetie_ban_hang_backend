import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferDto, UpdateTransferDto, TransferQueryDto } from './dto';

@Injectable()
export class TransfersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: TransferQueryDto) {
    const {
      fromBranchIds,
      toBranchIds,
      status,
      pageSize = 20,
      currentItem = 0,
      fromReceivedDate,
      toReceivedDate,
      fromTransferDate,
      toTransferDate,
    } = query;

    const where: any = {};

    if (fromBranchIds && fromBranchIds.length > 0) {
      where.fromBranchId = { in: fromBranchIds };
    }
    if (toBranchIds && toBranchIds.length > 0) {
      where.toBranchId = { in: toBranchIds };
    }
    if (status && status.length > 0) {
      where.status = { in: status };
    }
    if (fromReceivedDate || toReceivedDate) {
      where.receivedDate = {};
      if (fromReceivedDate) where.receivedDate.gte = fromReceivedDate;
      if (toReceivedDate) where.receivedDate.lte = toReceivedDate;
    }
    if (fromTransferDate || toTransferDate) {
      where.transferredDate = {};
      if (fromTransferDate) where.transferredDate.gte = fromTransferDate;
      if (toTransferDate) where.transferredDate.lte = toTransferDate;
    }

    const [total, data] = await Promise.all([
      this.prisma.transfer.count({ where }),
      this.prisma.transfer.findMany({
        where,
        skip: currentItem,
        take: Math.min(pageSize, 100),
        include: {
          fromBranch: { select: { id: true, name: true } },
          toBranch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: { select: { id: true, code: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { total, pageSize, data };
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

    return this.prisma.transfer.update({
      where: { id },
      data: {
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        status: dto.status,
        noteBySource: dto.description,
        totalTransfer,
        details: {
          deleteMany: {},
          create:
            dto.transferDetails?.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: '',
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
}
