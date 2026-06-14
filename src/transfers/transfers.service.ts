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
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import { recalcOnHandForPairs } from '../common/inventory-onhand.util';

@Injectable()
export class TransfersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: TransferQueryDto) {
    const {
      search,
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

    if (search && search.trim()) {
      where.code = { contains: search.trim(), mode: 'insensitive' };
    }

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

    const [products, inventoriesTo] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, code: true },
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

      // Cho phép chuyển vượt quá tồn kho hiện có — tồn kho chi nhánh nguồn
      // được phép âm (cộng dồn) theo yêu cầu nghiệp vụ.
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

    await this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'TRANSFER_CREATE',
      entityType: 'transfers',
      entityId: transfer.id.toString(),
      entityCode: transfer.code,
      category: getCategoryFromActionCode('TRANSFER_CREATE'),
      severity: getSeverityFromActionCode('TRANSFER_CREATE'),
      snapshot: this.buildTransferSnapshot(transfer),
      message: renderAuditMessage('TRANSFER_CREATE', {
        transferCode: transfer.code,
        fromBranch: fromBranch.name,
        toBranch: toBranch.name,
      }),
      messageTemplate: 'TRANSFER_CREATE',
      userId,
      userName: user.name || 'System',
      branchId: fromBranch.id,
    });

    return transfer;
  }

  async update(id: number, dto: UpdateTransferDto, userId?: number) {
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

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'TRANSFER_UPDATE',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: updatedTransfer.code,
        category: getCategoryFromActionCode('TRANSFER_UPDATE'),
        severity: getSeverityFromActionCode('TRANSFER_UPDATE'),
        snapshot: this.buildTransferSnapshot(updatedTransfer),
        changes: buildChanges(
          'transfers',
          {
            status: currentTransfer.status,
            noteBySource: currentTransfer.noteBySource,
            noteByDestination: currentTransfer.noteByDestination,
          },
          {
            status: updatedTransfer.status,
            noteBySource: updatedTransfer.noteBySource,
            noteByDestination: updatedTransfer.noteByDestination,
          },
        ),
        message: renderAuditMessage('TRANSFER_UPDATE', {
          transferCode: updatedTransfer.code,
        }),
        messageTemplate: 'TRANSFER_UPDATE',
        userId,
        userName: user?.name || 'System',
        branchId: updatedTransfer.fromBranchId,
      });
    }

    return updatedTransfer;
  }

  async remove(id: number, userId?: number) {
    const transfer = await this.findOne(id);

    await this.prisma.transfer.delete({ where: { id } });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'TRANSFER_DELETE',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: transfer.code,
        category: getCategoryFromActionCode('TRANSFER_DELETE'),
        severity: getSeverityFromActionCode('TRANSFER_DELETE'),
        snapshot: this.buildTransferSnapshot(transfer),
        message: renderAuditMessage('TRANSFER_DELETE', {
          transferCode: transfer.code,
        }),
        messageTemplate: 'TRANSFER_DELETE',
        userId,
        userName: user?.name || 'System',
      });
    }

    return { message: 'Xóa dữ liệu thành công' };
  }

  private async generateTransferCode(): Promise<string> {
    const prefix = 'TRF';

    const last = await this.prisma.transfer.findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });

    const lastNumber = last ? parseInt(last.code.replace(prefix, ''), 10) : 0;

    let nextNumber = lastNumber + 1;
    let code = `${prefix}${String(nextNumber).padStart(6, '0')}`;

    // Đảm bảo không trùng trong trường hợp edge case
    while (await this.prisma.transfer.findUnique({ where: { code } })) {
      nextNumber++;
      code = `${prefix}${String(nextNumber).padStart(6, '0')}`;
    }

    return code;
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

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
          include: {
            product: {
              select: {
                weight: true,
                weightUnit: true,
              },
            },
          },
        });

        if (!inventory) {
          throw new NotFoundException(
            `Không tìm thấy tồn kho cho sản phẩm ${detail.productCode} tại chi nhánh ${transfer.fromBranch.name}`,
          );
        }

        // Cho phép tồn kho chi nhánh nguồn âm (cộng dồn) — không chặn khi
        // onHand < sendQuantity theo yêu cầu nghiệp vụ.

        const newOnHand =
          Number(inventory.onHand) - Number(detail.sendQuantity);
        const weight = inventory.product.weight
          ? Number(inventory.product.weight)
          : 0;
        const totalWeight = weight * newOnHand;

        await tx.inventory.update({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
          data: {
            onHand: { decrement: detail.sendQuantity },
            totalWeight: totalWeight,
          },
        });

        await tx.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.fromBranchId,
            branchName: transfer.fromBranch?.name || '',
            transactionType: 'TRANSFER_OUT',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: -Number(detail.sendQuantity),
            costPrice: inventory ? Number(inventory.cost) : 0,
            transactionPrice: null,
            partnerName: null,
          },
        });
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nguồn).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });
  }

  private async incrementInventoryFromBranch(transferId: number) {
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

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
          where: {
            productId_branchId: {
              productId: detail.productId,
              branchId: transfer.fromBranchId,
            },
          },
        });

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

        // Ghi thẻ kho đảo chiều CHUYỂN khi hoàn tác (2→1): cộng lại số chuyển đi.
        // Gộp với dòng TRANSFER_OUT -sendQuantity trước đó sẽ triệt tiêu về 0.
        if (Number(detail.sendQuantity) > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_OUT',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: inventory ? Number(inventory.cost) : 0,
              transactionPrice: null,
              partnerName: null,
            },
          });
        }
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nguồn).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
      );
    });
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

    await this.prisma.$transaction(async (tx) => {
      for (const detail of transfer.details) {
        const inventory = await tx.inventory.findUnique({
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

        await tx.inventory.update({
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

        // Ghi thẻ kho chiều NHẬN: cộng đúng số lượng nhận thực tế của chi
        // nhánh nhận (có thể khác số chuyển đi). Bỏ qua khi nhận = 0.
        if (Number(detail.receivedQuantity) > 0) {
          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.toBranchId,
              branchName: transfer.toBranch?.name || '',
              transactionType: 'TRANSFER_IN',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.receivedQuantity),
              costPrice: inventory ? Number(inventory.cost) : 0,
              transactionPrice: null,
              partnerName: null,
            },
          });
        }
      }

      // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nhận).
      await recalcOnHandForPairs(
        tx,
        transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.toBranchId,
        })),
      );
    });
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
      const inventorySnapshot = await this.prisma.inventory.findUnique({
        where: {
          productId_branchId: {
            productId: detail.productId,
            branchId: transfer.toBranchId,
          },
        },
      });

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

      // Ghi thẻ kho đảo chiều NHẬN khi hoàn tác (3→2): trừ đúng số đã nhận.
      // Gộp với dòng TRANSFER_IN +receivedQuantity trước đó sẽ triệt tiêu về 0.
      if (Number(detail.receivedQuantity) > 0) {
        await this.prisma.inventoryLog.create({
          data: {
            productId: detail.productId,
            productCode: detail.productCode,
            productName: detail.productName,
            branchId: transfer.toBranchId,
            branchName: transfer.toBranchName || '',
            transactionType: 'TRANSFER_IN',
            refCode: transfer.code,
            refType: 'transfer',
            refId: transfer.id,
            quantity: -Number(detail.receivedQuantity),
            costPrice: inventorySnapshot ? Number(inventorySnapshot.cost) : 0,
            transactionPrice: null,
            partnerName: null,
          },
        });
      }
    }

    // NGUỒN CHÂN LÝ: onHand = Σ log active (chi nhánh nhận).
    await recalcOnHandForPairs(
      this.prisma,
      transfer.details.map((d) => ({
        productId: d.productId,
        branchId: transfer.toBranchId,
      })),
    );
  }

  async cancelTransfer(id: number, dto: CancelTransferDto, userId?: number) {
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

      // THÊM ĐOẠN NÀY trước return
      if (userId) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'TRANSFER_CANCEL',
          entityType: 'transfers',
          entityId: id.toString(),
          entityCode: transfer.code,
          category: getCategoryFromActionCode('TRANSFER_CANCEL'),
          severity: getSeverityFromActionCode('TRANSFER_CANCEL'),
          snapshot: this.buildTransferSnapshot(transfer),
          message: renderAuditMessage('TRANSFER_CANCEL', {
            transferCode: transfer.code,
            cancelReason: dto.cancelReason || 'Không có lý do',
          }),
          messageTemplate: 'TRANSFER_CANCEL',
          userId,
          userName: user?.name || user?.email || 'System',
          branchId: transfer.fromBranchId,
        });
      }

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
          // Cộng lại tồn cho chi nhánh chuyển (atomic increment, không overwrite)
          const fromInv = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
          });

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

          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_CANCEL',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: fromInv ? Number(fromInv.cost) : 0,
              transactionPrice: null,
              partnerName: null,
            },
          });
        }
      }

      if (transfer.status === 3) {
        for (const detail of transfer.details) {
          // Cộng lại tồn cho chi nhánh chuyển (atomic increment, không overwrite)
          const fromInv = await tx.inventory.findUnique({
            where: {
              productId_branchId: {
                productId: detail.productId,
                branchId: transfer.fromBranchId,
              },
            },
          });

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

          await tx.inventoryLog.create({
            data: {
              productId: detail.productId,
              productCode: detail.productCode,
              productName: detail.productName,
              branchId: transfer.fromBranchId,
              branchName: transfer.fromBranch?.name || '',
              transactionType: 'TRANSFER_CANCEL',
              refCode: transfer.code,
              refType: 'transfer',
              refId: transfer.id,
              quantity: Number(detail.sendQuantity),
              costPrice: fromInv ? Number(fromInv.cost) : 0,
              transactionPrice: null,
              partnerName: null,
            },
          });

          // Trừ tồn ở chi nhánh nhận đúng số lượng đã nhận thực tế
          // (atomic decrement, không overwrite — cho phép âm vì hệ thống đã chấp nhận tồn âm)
          if (Number(detail.receivedQuantity) > 0) {
            const toInv = await tx.inventory.findUnique({
              where: {
                productId_branchId: {
                  productId: detail.productId,
                  branchId: transfer.toBranchId,
                },
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

            await tx.inventoryLog.create({
              data: {
                productId: detail.productId,
                productCode: detail.productCode,
                productName: detail.productName,
                branchId: transfer.toBranchId,
                branchName: transfer.toBranch?.name || '',
                transactionType: 'TRANSFER_CANCEL',
                refCode: transfer.code,
                refType: 'transfer',
                refId: transfer.id,
                quantity: -Number(detail.receivedQuantity),
                costPrice: toInv ? Number(toInv.cost) : 0,
                transactionPrice: null,
                partnerName: null,
              },
            });
          }
        }
      }

      // NGUỒN CHÂN LÝ: phiếu đã hủy (status=4) → mọi log transfer thành
      // inactive → recalc loại sạch tác động transfer khỏi cả 2 chi nhánh.
      await recalcOnHandForPairs(tx, [
        ...transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.fromBranchId,
        })),
        ...transfer.details.map((d) => ({
          productId: d.productId,
          branchId: transfer.toBranchId,
        })),
      ]);
    });

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'TRANSFER_CANCEL',
        entityType: 'transfers',
        entityId: id.toString(),
        entityCode: transfer.code,
        category: getCategoryFromActionCode('TRANSFER_CANCEL'),
        severity: getSeverityFromActionCode('TRANSFER_CANCEL'),
        snapshot: this.buildTransferSnapshot(transfer),
        message: renderAuditMessage('TRANSFER_CANCEL', {
          // ✅ sửa từ hardcode string
          transferCode: transfer.code,
          cancelReason: dto.cancelReason || 'Không có lý do',
        }),
        messageTemplate: 'TRANSFER_CANCEL',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: transfer.fromBranchId,
      });
    }

    return { message: 'Hủy phiếu chuyển hàng thành công' };
  }

  private buildTransferSnapshot(transfer: any) {
    return {
      code: transfer.code,
      status: transfer.status,
      fromBranchId: transfer.fromBranchId,
      fromBranchName: transfer.fromBranchName || transfer.fromBranch?.name,
      toBranchId: transfer.toBranchId,
      toBranchName: transfer.toBranchName || transfer.toBranch?.name,
      totalTransfer: Number(transfer.totalTransfer || 0),
      totalReceive: Number(transfer.totalReceive || 0),
      noteBySource: transfer.noteBySource,
      noteByDestination: transfer.noteByDestination,
      transferredDate: transfer.transferredDate,
      receivedDate: transfer.receivedDate,
      createdByName: transfer.createdByName || transfer.creator?.name,
      details: (transfer.details || []).map((d: any) => ({
        productId: d.productId,
        productCode: d.productCode,
        productName: d.productName,
        sendQuantity: Number(d.sendQuantity),
        receivedQuantity: Number(d.receivedQuantity),
        sendPrice: Number(d.sendPrice),
      })),
    };
  }
}
