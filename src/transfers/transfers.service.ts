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

    const productIds = dto.transferDetails.map((d) => d.productId);
    const finalStatus = dto.status || 1;

    const [products, inventoriesFrom, inventoriesTo] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.inventory.findMany({
        where: {
          productId: { in: productIds },
          branchId: dto.fromBranchId,
        },
        select: { productId: true, onHand: true },
      }),
      this.prisma.inventory.findMany({
        where: {
          productId: { in: productIds },
          branchId: dto.toBranchId,
        },
        select: { productId: true },
      }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p.name]));
    const inventoryFromMap = new Map(
      inventoriesFrom.map((inv) => [inv.productId, Number(inv.onHand)]),
    );
    const inventoryToSet = new Set(inventoriesTo.map((inv) => inv.productId));

    if (finalStatus >= 2) {
      const missingInBranchB: string[] = [];
      for (const detail of dto.transferDetails) {
        if (!inventoryToSet.has(detail.productId)) {
          const product = products.find((p) => p.id === detail.productId);
          missingInBranchB.push(product?.code || `ID ${detail.productId}`);
        }
      }

      if (missingInBranchB.length > 0) {
        throw new BadRequestException(
          `Các sản phẩm sau chưa tồn tại ở chi nhánh "${toBranch.name}": ${missingInBranchB.join(', ')}. Vui lòng tạo sản phẩm tại chi nhánh đích trước khi chuyển hàng.`,
        );
      }

      for (const detail of dto.transferDetails) {
        const availableStock = inventoryFromMap.get(detail.productId) || 0;
        if (detail.sendQuantity > availableStock) {
          const product = products.find((p) => p.id === detail.productId);
          throw new BadRequestException(
            `Sản phẩm "${product?.code || detail.productId}" không đủ tồn kho tại chi nhánh "${fromBranch.name}". Tồn kho hiện tại: ${availableStock}, yêu cầu: ${detail.sendQuantity}`,
          );
        }
      }
    }

    const code = dto.code || (await this.generateTransferCode());

    const totalTransfer = dto.transferDetails.reduce(
      (sum, item) => sum + item.sendQuantity * item.price,
      0,
    );

    const transfer = await this.prisma.transfer.create({
      data: {
        code,
        fromBranchId: dto.fromBranchId,
        toBranchId: dto.toBranchId,
        fromBranchName: fromBranch.name,
        toBranchName: toBranch.name,
        createdById: userId,
        createdByName: user.name,
        status: finalStatus,
        noteBySource: dto.description,
        totalTransfer,
        transferredDate: finalStatus === 2 ? new Date() : null,
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

    if (finalStatus === 2) {
      await this.decrementInventoryFromBranch(transfer.id);
    } else if (finalStatus === 3) {
      await this.decrementInventoryFromBranch(transfer.id);
      await this.incrementInventoryToBranch(transfer.id);
    }

    return transfer;
  }

  async update(id: number, dto: UpdateTransferDto) {
    const currentTransfer = await this.findOne(id);
    const newStatus =
      dto.status !== undefined ? dto.status : currentTransfer.status;

    if (newStatus >= 2 && dto.transferDetails) {
      const productIds = dto.transferDetails.map((d) => d.productId);

      const inventoriesTo = await this.prisma.inventory.findMany({
        where: {
          productId: { in: productIds },
          branchId: currentTransfer.toBranchId,
        },
        select: { productId: true },
      });

      const inventoryToSet = new Set(inventoriesTo.map((inv) => inv.productId));
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, code: true },
      });

      const missingInBranchB: string[] = [];
      for (const detail of dto.transferDetails) {
        if (!inventoryToSet.has(detail.productId)) {
          const product = products.find((p) => p.id === detail.productId);
          missingInBranchB.push(product?.code || `ID ${detail.productId}`);
        }
      }

      if (missingInBranchB.length > 0) {
        throw new BadRequestException(
          `Các sản phẩm sau chưa tồn tại ở chi nhánh đích: ${missingInBranchB.join(', ')}. Vui lòng tạo sản phẩm tại chi nhánh đích trước.`,
        );
      }
    }

    const totalTransfer =
      dto.transferDetails?.reduce((sum, item) => {
        return sum + item.sendQuantity * item.price;
      }, 0) || currentTransfer.totalTransfer;

    const totalReceive =
      dto.transferDetails?.reduce((sum, item) => {
        const receivedQty = item.receivedQuantity || 0;
        return sum + receivedQty * item.price;
      }, 0) || currentTransfer.totalReceive;

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
        status: newStatus,
        noteBySource: dto.description,
        noteByDestination: dto.destination_description,
        totalTransfer,
        totalReceive,
        receivedDate:
          newStatus === 3 && currentTransfer.status !== 3
            ? new Date()
            : currentTransfer.receivedDate,
        transferredDate:
          newStatus === 2 && currentTransfer.status === 1
            ? new Date()
            : currentTransfer.transferredDate,
        ...(dto.transferDetails && {
          details: {
            deleteMany: {},
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
        }),
      },
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
      },
    });

    const oldStatus = currentTransfer.status;

    if (oldStatus === 1 && newStatus === 2) {
      await this.decrementInventoryFromBranch(id);
    } else if (oldStatus === 1 && newStatus === 3) {
      await this.decrementInventoryFromBranch(id);
      await this.incrementInventoryToBranch(id);
    } else if (oldStatus === 2 && newStatus === 1) {
      await this.incrementInventoryFromBranch(id);
    } else if (oldStatus === 2 && newStatus === 3) {
      await this.incrementInventoryToBranch(id);
    } else if (oldStatus === 3 && newStatus === 2) {
      await this.decrementInventoryToBranch(id);
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
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      const inventoryFrom = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
          },
        },
      });

      if (!inventoryFrom) {
        throw new NotFoundException(
          `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.fromBranch.name}`,
        );
      }

      if (Number(inventoryFrom.onHand) < Number(detail.sendQuantity)) {
        throw new BadRequestException(
          `Sản phẩm ${detail.productCode} không đủ tồn kho. Tồn hiện tại: ${inventoryFrom.onHand}, yêu cầu: ${detail.sendQuantity}`,
        );
      }

      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
          },
        },
        data: {
          onHand: { decrement: detail.sendQuantity },
        },
      });
    }
  }

  private async updateInventoryOnReceive(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        fromBranch: true,
        toBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      const inventoryTo = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
      });

      if (!inventoryTo) {
        throw new NotFoundException(
          `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.toBranch.name}`,
        );
      }

      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
        data: {
          onHand: { increment: detail.receivedQuantity },
        },
      });
    }
  }

  private async decrementInventoryFromBranch(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        fromBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
          },
        },
      });

      if (!inventory) {
        throw new NotFoundException(
          `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.fromBranch.name}`,
        );
      }

      if (Number(inventory.onHand) < Number(detail.sendQuantity)) {
        throw new BadRequestException(
          `Sản phẩm ${detail.productCode} không đủ tồn kho. Tồn hiện tại: ${inventory.onHand}, yêu cầu: ${detail.sendQuantity}`,
        );
      }

      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
          },
        },
        data: {
          onHand: { decrement: detail.sendQuantity },
        },
      });
    }
  }

  private async incrementInventoryFromBranch(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.fromBranchId,
          },
        },
        data: {
          onHand: { increment: detail.sendQuantity },
        },
      });
    }
  }

  private async incrementInventoryToBranch(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
        toBranch: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      const inventory = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
      });

      if (!inventory) {
        throw new NotFoundException(
          `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.toBranch.name}`,
        );
      }

      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
        data: {
          onHand: { increment: detail.receivedQuantity },
        },
      });
    }
  }

  private async decrementInventoryToBranch(transferId: number) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        details: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException(
        `Transfer với ID ${transferId} không tồn tại`,
      );
    }

    for (const detail of transfer.details) {
      await this.prisma.inventory.update({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
        data: {
          onHand: { decrement: detail.receivedQuantity },
        },
      });
    }
  }

  async cancelTransfer(id: number, dto: CancelTransferDto) {
    const transfer = await this.findOne(id);

    if (transfer.status === 4) {
      throw new BadRequestException('Phiếu chuyển hàng đã bị hủy');
    }

    if (transfer.status === 1) {
      await this.prisma.transfer.update({
        where: { id },
        data: {
          status: 4,
          noteBySource: dto.cancelReason
            ? `${transfer.noteBySource ? transfer.noteBySource + ' | ' : ''}Lý do hủy: ${dto.cancelReason}`
            : transfer.noteBySource,
        },
      });

      return { message: 'Hủy phiếu chuyển hàng thành công' };
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
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });
        }
      }

      if (transfer.status === 3) {
        for (const detail of transfer.details) {
          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
            data: {
              onHand: { increment: detail.sendQuantity },
            },
          });

          await tx.inventory.update({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.toBranchId,
              },
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
