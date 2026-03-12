import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  InvoiceQueryDto,
  INVOICE_STATUS,
  getStatusLabel,
  CreateInvoiceFromOrderDto,
} from './dto';
import {
  ORDER_STATUS,
  getStatusLabel as getOrderStatusLabel,
} from '../orders/dto/order-status.constants';
import { OrdersService } from '../orders/orders.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: InvoiceQueryDto) {
    const {
      page = 1,
      limit = 15,
      pageSize,
      currentItem,
      search,
      customerIds,
      branchId,
      statusIds,
      fromDate,
      toDate,
      fromPurchaseDate,
      toPurchaseDate,
      fromCreatedDate,
      toCreatedDate,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where: any = {};

    if (search) {
      where.OR = [
        { code: { contains: search } },
        { customer: { name: { contains: search } } },
        { description: { contains: search } },
      ];
    }

    if (customerIds && customerIds.length > 0) {
      where.customerId = { in: customerIds };
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (statusIds && statusIds.length > 0) {
      where.status = { in: statusIds };
    }

    if (fromDate || toDate || fromPurchaseDate || toPurchaseDate) {
      where.purchaseDate = {};
      if (fromDate) where.purchaseDate.gte = new Date(fromDate);
      if (toDate) where.purchaseDate.lte = new Date(toDate);
      if (fromPurchaseDate) where.purchaseDate.gte = new Date(fromPurchaseDate);
      if (toPurchaseDate) where.purchaseDate.lte = new Date(toPurchaseDate);
    }

    if (fromCreatedDate || toCreatedDate) {
      where.createdAt = {};
      if (fromCreatedDate) where.createdAt.gte = new Date(fromCreatedDate);
      if (toCreatedDate) where.createdAt.lte = new Date(toCreatedDate);
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip: effectiveSkip,
        take: effectiveLimit,
        include: {
          customer: true,
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
          payments: true,
          delivery: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: true,
        branch: true,
        soldBy: true,
        creator: true,
        details: { include: { product: true } },
        payments: true,
        delivery: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found`);
    }

    return invoice;
  }

  async create(dto: CreateInvoiceDto, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.generateSafeInvoiceCode(tx);

      const totalAmount = dto.items.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );
      const discountAmount = dto.discountAmount || 0;
      const discountFromRatio = (totalAmount * (dto.discountRatio || 0)) / 100;
      const grandTotal = totalAmount - discountAmount - discountFromRatio;
      const paidAmount = dto.paidAmount || 0;
      const debtAmount = grandTotal - paidAmount;

      let status: number = INVOICE_STATUS.PROCESSING;
      if (debtAmount <= 0) {
        status = INVOICE_STATUS.COMPLETED;
      }

      const customer = dto.customerId
        ? await tx.customer.findUnique({
            where: { id: dto.customerId },
            select: { totalDebt: true },
          })
        : null;

      const currentCustomerDebt = Number(customer?.totalDebt || 0);
      const customerDebtSnapshot = currentCustomerDebt + debtAmount;

      const applicablePriceBooks = await tx.priceBook.findMany({
        where: {
          isActive: true,
          OR: [
            { isGlobal: true },
            { priceBookBranches: { some: { branchId: dto.branchId } } },
            ...(dto.customerId
              ? [
                  {
                    priceBookCustomerGroups: {
                      some: {
                        customerGroup: {
                          customerGroupDetails: {
                            some: { customerId: dto.customerId },
                          },
                        },
                      },
                    },
                  },
                  { forAllCusGroup: true },
                ]
              : []),
          ],
        },
        orderBy: { priority: 'desc' },
        take: 1,
      });

      const priceBook = applicablePriceBooks[0] || null;

      const invoice = await tx.invoice.create({
        data: {
          code,
          customerId: dto.customerId,
          branchId: dto.branchId,
          soldById: dto.soldById,
          saleChannelId: dto.saleChannelId,
          priceBookId: priceBook?.id || null,
          priceBookName: priceBook?.name || null,
          purchaseDate: dto.purchaseDate
            ? new Date(dto.purchaseDate)
            : new Date(),
          totalAmount,
          discount: discountAmount,
          discountRatio: dto.discountRatio || 0,
          grandTotal,
          paidAmount,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          usingCod: dto.usingCod || false,
          description: dto.description,
          createdBy: userId,
          customerDebtSnapshot,
          details: {
            createMany: {
              data: dto.items.map((item) => ({
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                discount: item.discount || 0,
                discountRatio: item.discountRatio || 0,
                totalPrice: item.totalPrice,
                note: item.note,
              })),
            },
          },
          ...(dto.delivery && {
            delivery: {
              create: {
                receiver: dto.delivery.receiver,
                contactNumber: dto.delivery.contactNumber,
                address: dto.delivery.address,
                locationName: dto.delivery.locationName,
                wardName: dto.delivery.wardName,
                weight: dto.delivery.weight,
                length: dto.delivery.length,
                width: dto.delivery.width,
                height: dto.delivery.height,
                noteForDriver: dto.delivery.noteForDriver,
              },
            },
          }),
        },
        include: {
          details: true,
          payments: true,
          delivery: true,
        },
      });

      if (paidAmount > 0) {
        const existingPayments = await tx.invoicePayment.findMany({
          where: { invoiceId: invoice.id },
        });
        const paymentSequence = existingPayments.length + 1;
        const paymentCode = `TT${invoice.code}-${paymentSequence}`;

        const paymentCustomer = dto.customerId
          ? await tx.customer.findUnique({
              where: { id: dto.customerId },
              select: { id: true, name: true },
            })
          : null;

        await tx.invoicePayment.create({
          data: {
            code: paymentCode,
            invoiceId: invoice.id,
            status: 1,
            statusValue: 'Paid',
            amount: paidAmount,
            paymentDate: new Date(),
            paymentMethod: 'cash',
            description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
          },
        });

        if (paidAmount > 0) {
          if (!dto.branchId) {
            throw new Error('Vui lòng chọn chi nhánh');
          }

          await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: dto.branchId,
              isReceipt: true,
              amount: paidAmount,
              transDate: new Date(),
              method: 'cash',
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: paymentCustomer?.name,
              description: `Thu tiền hóa đơn ${invoice.code} - Lần ${paymentSequence}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot:
                currentCustomerDebt + grandTotal - paidAmount,
            },
          });
        }
      }

      for (const item of dto.items) {
        await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            branchId: dto.branchId,
          },
          data: {
            onHand: { decrement: item.quantity },
          },
        });
      }

      if (dto.customerId) {
        await this.updateCustomerTotals(dto.customerId, tx);
      }

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          branch: true,
          soldBy: true,
          priceBook: true,
        },
      });
    });
  }

  async update(id: number, dto: UpdateInvoiceDto, userId?: number) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const currentInvoice = await tx.invoice.findUnique({
        where: { id },
        include: {
          details: true,
          customer: { select: { totalDebt: true, code: true, name: true } },
          payments: true,
          delivery: true,
          branch: true,
          soldBy: true,
          order: true,
        },
      });

      if (!currentInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      if (
        dto.items &&
        this.hasProductChanges(currentInvoice.details, dto.items)
      ) {
        const newCode = await this.generateInvoiceCodeWithSuffix(
          currentInvoice.code,
          tx,
        );

        const { cancelLog, newLog } = this.buildProductChangesLog(
          currentInvoice.details,
          dto.items,
        );

        const userName = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });

        await this.auditLogsService.create({
          actionType: 'DELETE',
          actionCode: 'INVOICE_CANCEL',
          entityType: 'invoices',
          entityId: String(currentInvoice.id),
          entityCode: currentInvoice.code,
          oldValues: currentInvoice,
          message: `Hủy hóa đơn ${currentInvoice.code} (tạo hóa đơn mới: ${newCode}), (cho đơn đặt hàng: ${currentInvoice.order?.code || 'N/A'}), khách hàng ${currentInvoice.customer?.name || 'N/A'}, với giá trị: ${new Intl.NumberFormat('vi-VN').format(Number(currentInvoice.grandTotal))}, thời gian: ${new Date().toLocaleString('vi-VN')}, Người hủy: ${userName?.name || 'System'}, Người bán: ${currentInvoice.soldBy?.name || userName?.name || 'System'}, tại kho: ${currentInvoice.branch?.name || 'N/A'}. \nBao gồm:\n- ${cancelLog}\n- Ghi chú: ${currentInvoice.description || ''}\n\nThông tin giao hàng:\n${currentInvoice.delivery ? `- Người nhận: ${currentInvoice.delivery.receiver || 'N/A'}\n- Số điện thoại: ${currentInvoice.delivery.contactNumber || 'N/A'}\n- Địa chỉ: ${currentInvoice.delivery.address || 'N/A'}\n- Trọng lượng: ${currentInvoice.delivery.weight || 0}\n- Kích thước: ${currentInvoice.delivery.length || 0} - ${currentInvoice.delivery.width || 0} - ${currentInvoice.delivery.height || 0}\n${currentInvoice.delivery.price ? `- Phí giao hàng: ${new Intl.NumberFormat('vi-VN').format(Number(currentInvoice.delivery.price))}` : ''}\n${currentInvoice.delivery.noteForDriver ? `- Thu hộ tiền hàng: ${currentInvoice.delivery.noteForDriver}` : ''}\n- Trạng thái giao: ${currentInvoice.delivery.statusValue || 'Chờ xử lý'}` : '- Không có thông tin giao hàng'}`,
          userId: userId || currentInvoice.createdBy,
          userName: userName?.name || 'System',
          branchId: currentInvoice.branchId || undefined,
        });

        for (const oldDetail of currentInvoice.details) {
          await tx.inventory.updateMany({
            where: {
              productId: oldDetail.productId,
              branchId: currentInvoice.branchId || 1,
            },
            data: {
              onHand: { increment: Number(oldDetail.quantity) },
            },
          });
        }

        await tx.invoice.update({
          where: { id },
          data: { status: INVOICE_STATUS.CANCELLED, statusValue: 'Đã hủy' },
        });

        const totalAmount = dto.items.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        const discountAmount = dto.discountAmount || 0;
        const discountFromRatio =
          (totalAmount * (dto.discountRatio || 0)) / 100;
        const grandTotal = totalAmount - discountAmount - discountFromRatio;
        const paidAmount = currentInvoice.payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
        const debtAmount = grandTotal - paidAmount;

        let status: number = INVOICE_STATUS.PROCESSING;
        if (debtAmount <= 0) status = INVOICE_STATUS.COMPLETED;

        const customerDebtSnapshot = currentInvoice.customer
          ? Number(currentInvoice.customer.totalDebt) -
            Number(currentInvoice.debtAmount) +
            debtAmount
          : null;

        const newInvoice = await tx.invoice.create({
          data: {
            code: newCode,
            orderId: currentInvoice.orderId,
            customerId: dto.customerId ?? currentInvoice.customerId,
            branchId: dto.branchId ?? currentInvoice.branchId,
            soldById: dto.soldById ?? currentInvoice.soldById,
            saleChannelId: currentInvoice.saleChannelId,
            priceBookId: currentInvoice.priceBookId,
            priceBookName: currentInvoice.priceBookName,
            purchaseDate: dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : currentInvoice.purchaseDate,
            totalAmount,
            discount: discountAmount,
            discountRatio: dto.discountRatio || 0,
            grandTotal,
            paidAmount,
            debtAmount,
            status,
            statusValue: getStatusLabel(status),
            customerDebtSnapshot,
            usingCod: currentInvoice.usingCod,
            description: dto.description ?? currentInvoice.description,
            createdBy: currentInvoice.createdBy,
            details: {
              create: dto.items.map((item) => ({
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                discount: item.discount || 0,
                discountRatio: item.discountRatio || 0,
                totalPrice: item.totalPrice,
                note: item.note,
              })),
            },
            ...(dto.delivery
              ? {
                  delivery: {
                    create: {
                      receiver: dto.delivery.receiver,
                      contactNumber: dto.delivery.contactNumber,
                      address: dto.delivery.address,
                      locationName: dto.delivery.locationName,
                      wardName: dto.delivery.wardName,
                      weight: dto.delivery.weight,
                      length: dto.delivery.length,
                      width: dto.delivery.width,
                      height: dto.delivery.height,
                      noteForDriver: dto.delivery.noteForDriver,
                      status: 1,
                      statusValue: 'Chờ xử lý',
                    },
                  },
                }
              : currentInvoice.delivery
                ? {
                    delivery: {
                      create: {
                        receiver: currentInvoice.delivery.receiver,
                        contactNumber: currentInvoice.delivery.contactNumber,
                        address: currentInvoice.delivery.address,
                        locationName: currentInvoice.delivery.locationName,
                        wardName: currentInvoice.delivery.wardName,
                        weight: currentInvoice.delivery.weight,
                        length: currentInvoice.delivery.length,
                        width: currentInvoice.delivery.width,
                        height: currentInvoice.delivery.height,
                        noteForDriver: currentInvoice.delivery.noteForDriver,
                        status: currentInvoice.delivery.status,
                        statusValue: currentInvoice.delivery.statusValue,
                      },
                    },
                  }
                : {}),
          },
          include: {
            details: true,
            delivery: true,
            customer: true,
            order: true,
            branch: true,
            soldBy: true,
            priceBook: true,
          },
        });

        for (const payment of currentInvoice.payments) {
          await tx.invoicePayment.update({
            where: { id: payment.id },
            data: {
              invoiceId: newInvoice.id,
              description: `${payment.description || 'Thanh toán hóa đơn'} (Chuyển từ ${currentInvoice.code} sang ${newCode})`,
            },
          });
        }

        for (const item of dto.items) {
          await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              branchId: newInvoice.branchId || 1,
            },
            data: {
              onHand: { decrement: item.quantity },
            },
          });
        }

        if (newInvoice.customerId) {
          await this.updateCustomerTotals(newInvoice.customerId, tx);
        }

        if (currentInvoice.orderId) {
          await this.ordersService['updateOrderStatusByInvoices'](
            currentInvoice.orderId,
            tx,
          );
        }

        const deliveryInfo = dto.delivery || currentInvoice.delivery;
        const deliveryLog = deliveryInfo
          ? `\nThông tin giao hàng:\n- Người nhận: ${deliveryInfo.receiver || ''}\n- Phí giao hàng: ${'price' in deliveryInfo ? deliveryInfo.price || 0 : 0}\n- Thu hộ tiền hàng: ${deliveryInfo.noteForDriver ? 'Có' : 'Không'}\n- Trạng thái giao: Chờ xử lý`
          : '';

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'INVOICE_CREATE_FROM_CANCELLED',
          entityType: 'invoices',
          entityId: String(newInvoice.id),
          entityCode: newCode,
          newValues: newInvoice,
          message: `Tạo hóa đơn ${newCode} từ đơn hàng: ${currentInvoice.order?.code}. \nBao gồm:\n- ${newLog}\n- Ghi chú: ${dto.description || ''}${deliveryLog}`,
          userId: userId || currentInvoice.createdBy,
          userName: userName?.name || 'System',
          branchId: newInvoice.branchId || undefined,
        });

        return tx.invoice.findUnique({
          where: { id: newInvoice.id },
          include: {
            details: true,
            payments: true,
            delivery: true,
            customer: true,
            branch: true,
            soldBy: true,
            order: true,
            priceBook: true,
          },
        });
      }

      const updateData: any = {};

      if (dto.customerId !== undefined) updateData.customerId = dto.customerId;
      if (dto.branchId !== undefined) updateData.branchId = dto.branchId;
      if (dto.soldById !== undefined) updateData.soldById = dto.soldById;
      if (dto.description !== undefined)
        updateData.description = dto.description;

      let shouldUpdateCustomerDebt = false;
      let newCustomerDebt = 0;

      if (dto.status !== undefined) {
        if (
          dto.status === INVOICE_STATUS.CANCELLED &&
          currentInvoice.status !== INVOICE_STATUS.CANCELLED
        ) {
          if (!currentInvoice.branchId) {
            throw new BadRequestException(
              'Không thể hủy hóa đơn vì không có thông tin chi nhánh',
            );
          }

          for (const detail of currentInvoice.details) {
            await tx.inventory.updateMany({
              where: {
                productId: detail.productId,
                branchId: currentInvoice.branchId,
              },
              data: {
                onHand: { increment: Number(detail.quantity) },
              },
            });
          }

          updateData.debtAmount = 0;

          if (currentInvoice.customerId && currentInvoice.customer) {
            const currentCustomerDebt = Number(
              currentInvoice.customer.totalDebt,
            );
            const grandTotal = Number(currentInvoice.grandTotal);
            const debtAmount = Number(currentInvoice.debtAmount);
            const paidAmount = Number(currentInvoice.paidAmount);

            if (dto.cancelPayments === true) {
              newCustomerDebt = currentCustomerDebt - debtAmount;

              if (paidAmount > 0 && currentInvoice.payments.length > 0) {
                for (const payment of currentInvoice.payments) {
                  await tx.cashFlow.updateMany({
                    where: { code: payment.code },
                    data: {
                      status: 2,
                      statusValue: 'Đã hủy',
                    },
                  });
                }

                await tx.invoicePayment.updateMany({
                  where: { invoiceId: id },
                  data: {
                    status: 2,
                    statusValue: 'Đã hủy',
                  },
                });

                updateData.paidAmount = 0;
              }
            } else {
              newCustomerDebt = currentCustomerDebt - grandTotal;
            }

            shouldUpdateCustomerDebt = true;
          }
        }

        updateData.status = dto.status;
        updateData.statusValue = getStatusLabel(dto.status);
      }

      if (dto.delivery) {
        await tx.invoiceDelivery.deleteMany({
          where: { invoiceId: id },
        });
        updateData.delivery = {
          create: {
            receiver: dto.delivery.receiver,
            contactNumber: dto.delivery.contactNumber,
            address: dto.delivery.address,
            locationName: dto.delivery.locationName,
            wardName: dto.delivery.wardName,
            weight: dto.delivery.weight,
            length: dto.delivery.length,
            width: dto.delivery.width,
            height: dto.delivery.height,
            noteForDriver: dto.delivery.noteForDriver,
          },
        };
      }

      const needRecalculatePriceBook =
        (dto.customerId !== undefined &&
          dto.customerId !== currentInvoice.customerId) ||
        (dto.branchId !== undefined &&
          dto.branchId !== currentInvoice.branchId) ||
        (dto.soldById !== undefined &&
          dto.soldById !== currentInvoice.soldById);

      if (needRecalculatePriceBook) {
        const branchId = dto.branchId ?? currentInvoice.branchId;
        const customerId = dto.customerId ?? currentInvoice.customerId;

        const orConditions: any[] = [{ isGlobal: true }];

        if (branchId) {
          orConditions.push({
            priceBookBranches: {
              some: { branchId },
            },
          });
        }

        if (customerId) {
          orConditions.push(
            {
              priceBookCustomerGroups: {
                some: {
                  customerGroup: {
                    customerGroupDetails: {
                      some: { customerId },
                    },
                  },
                },
              },
            },
            { forAllCusGroup: true },
          );
        }

        const applicablePriceBooks = await tx.priceBook.findMany({
          where: {
            isActive: true,
            OR: orConditions,
          },
          orderBy: { priority: 'desc' },
          take: 1,
        });

        const priceBook = applicablePriceBooks[0] || null;
        updateData.priceBookId = priceBook?.id || null;
        updateData.priceBookName = priceBook?.name || null;
      }

      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: updateData,
        include: {
          customer: true,
          branch: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: { include: { product: true } },
          payments: true,
          delivery: true,
          priceBook: true,
        },
      });

      if (shouldUpdateCustomerDebt && currentInvoice.customerId) {
        await tx.customer.update({
          where: { id: currentInvoice.customerId },
          data: { totalDebt: newCustomerDebt },
        });
      }

      if (currentInvoice.orderId) {
        await this.ordersService['updateOrderStatusByInvoices'](
          currentInvoice.orderId,
          tx,
        );
      }

      return updatedInvoice;
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id },
      });

      if (!invoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found`);
      }

      await tx.invoice.delete({ where: { id } });

      if (invoice.orderId) {
        await this.ordersService['updateOrderStatusByInvoices'](
          invoice.orderId,
          tx,
        );
      }

      return invoice;
    });
  }

  private async updateCustomerTotals(customerId: number, tx: any) {
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [INVOICE_STATUS.CANCELLED] } },
    });

    const debtFromInvoices = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.debtAmount),
      0,
    );
    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );

    const orders = await tx.order.findMany({
      where: {
        customerId,
        orderStatus: { not: 'cancelled' },
        invoices: { none: {} },
      },
      include: { payments: true },
    });

    const paidFromOrdersWithoutInvoice = orders.reduce(
      (sum: number, o: any) => {
        return (
          sum +
          o.payments.reduce((s: number, p: any) => s + Number(p.amount), 0)
        );
      },
      0,
    );

    const totalDebt = debtFromInvoices - paidFromOrdersWithoutInvoice;

    await tx.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }

  async createFromOrder(
    orderId: number,
    dto: CreateInvoiceFromOrderDto,
    userId: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          payments: true,
          delivery: true,
          invoices: {
            where: { status: { not: INVOICE_STATUS.CANCELLED } },
            include: { details: true },
          },
          customer: {
            select: {
              id: true,
              name: true,
              contactNumber: true,
              address: true,
              totalDebt: true,
            },
          },
        },
      });

      if (!order) throw new NotFoundException('Order not found');
      if (order.status === ORDER_STATUS.CANCELLED) {
        throw new BadRequestException(
          'Không thể tạo hóa đơn từ đơn hàng đã hủy',
        );
      }
      if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BadRequestException('Đơn hàng đã hoàn thành');
      }
      if (!order.branchId) {
        throw new BadRequestException('Đơn hàng không có thông tin chi nhánh');
      }

      const invoicedQuantities: Record<number, number> = {};
      order.invoices.forEach((inv) => {
        inv.details.forEach((d) => {
          invoicedQuantities[d.productId] =
            (invoicedQuantities[d.productId] || 0) + Number(d.quantity);
        });
      });

      const remainingItems = order.items
        .map((item) => {
          const invoiced = invoicedQuantities[item.productId] || 0;
          const remaining = Number(item.quantity) - invoiced;
          return { ...item, remainingQuantity: remaining };
        })
        .filter((item) => item.remainingQuantity > 0);

      if (remainingItems.length === 0) {
        throw new BadRequestException(
          'Tất cả sản phẩm trong đơn hàng đã được xuất hóa đơn',
        );
      }

      const usedDiscount = order.invoices.reduce(
        (sum, inv) => sum + Number(inv.discount),
        0,
      );
      const remainingDiscount = Number(order.discount) - usedDiscount;
      const discountForThisInvoice =
        remainingDiscount > 0 ? remainingDiscount : 0;

      const code = await this.generateSafeInvoiceCode(tx);

      const isFirstInvoice = order.invoices.length === 0;

      const totalPaidFromOrder = isFirstInvoice
        ? order.payments.reduce((sum, p) => sum + Number(p.amount), 0)
        : 0;
      const additionalPayment = Number(dto.additionalPayment || 0);
      const totalPaid = totalPaidFromOrder + additionalPayment;

      const itemsToInvoice =
        dto.items && dto.items.length > 0
          ? dto.items
          : remainingItems.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.remainingQuantity,
              price: Number(item.price),
              discount: Number(item.discount),
              discountRatio: Number(item.discountRatio),
              totalPrice:
                (Number(item.price) - Number(item.discount)) *
                item.remainingQuantity,
              note: item.note,
            }));

      const totalAmount = itemsToInvoice.reduce(
        (sum, item) => sum + item.totalPrice,
        0,
      );

      const grandTotal = totalAmount - discountForThisInvoice;
      const debtAmount = grandTotal - totalPaid;

      const status =
        debtAmount <= 0 ? INVOICE_STATUS.COMPLETED : INVOICE_STATUS.PROCESSING;

      const currentCustomerDebt = Number(order.customer?.totalDebt || 0);
      const customerDebtSnapshot = currentCustomerDebt + debtAmount;

      const invoice = await tx.invoice.create({
        data: {
          code,
          orderId: order.id,
          customerId: order.customerId,
          branchId: order.branchId,
          soldById: order.soldById,
          saleChannelId: order.saleChannelId,
          priceBookId: order.priceBookId,
          priceBookName: order.priceBookName,
          purchaseDate: new Date(),
          totalAmount,
          discount: discountForThisInvoice,
          discountRatio: 0,
          grandTotal,
          paidAmount: totalPaid,
          debtAmount,
          status,
          statusValue: getStatusLabel(status),
          usingCod: order.usingCod || false,
          description: order.description,
          createdBy: userId,
          customerDebtSnapshot: null,
          details: {
            create: itemsToInvoice.map((item) => ({
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              quantity: item.quantity,
              price: item.price,
              discount: item.discount,
              discountRatio: item.discountRatio,
              totalPrice: item.totalPrice,
              note: item.note,
            })),
          },
          ...(order.delivery && {
            delivery: {
              create: {
                receiver: order.delivery.receiver,
                contactNumber: order.delivery.contactNumber,
                address: order.delivery.address,
                locationName: order.delivery.locationName,
                wardName: order.delivery.wardName,
                weight: order.delivery.weight,
                length: order.delivery.length,
                width: order.delivery.width,
                height: order.delivery.height,
              },
            },
          }),
        },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          priceBook: true,
        },
      });

      const cashFlowIdsToUpdate: number[] = [];

      if (isFirstInvoice && totalPaidFromOrder > 0) {
        for (const orderPayment of order.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TTTU${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: orderPayment.amount,
              transDate: orderPayment.paymentDate,
              method: orderPayment.paymentMethod || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.address,
              description: `Thu tiền tạm ứng từ đơn hàng ${order.code} sang hóa đơn ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: null,
            },
          });

          cashFlowIdsToUpdate.push(cashFlow.id);

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: orderPayment.amount,
              paymentDate: orderPayment.paymentDate,
              paymentMethod: orderPayment.paymentMethod,
              description: `Thanh toán từ đơn hàng ${order.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      if (dto.payments && dto.payments.length > 0) {
        for (const payment of dto.payments) {
          const seq = await tx.invoicePayment.count({
            where: { invoiceId: invoice.id },
          });
          const paymentCode = `TT${invoice.code}-${seq + 1}`;

          const cashFlow = await tx.cashFlow.create({
            data: {
              code: paymentCode,
              branchId: invoice.branchId || 1,
              cashFlowGroupId: 3,
              isReceipt: true,
              amount: payment.amount,
              transDate: new Date(),
              method: payment.method || 'cash',
              accountId: null,
              partnerType: 'C',
              partnerId: invoice.customerId,
              partnerName: invoice.customer?.name,
              contactNumber: invoice.customer?.contactNumber,
              address: invoice.customer?.address,
              description: `Thu tiền thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
              status: 0,
              statusValue: 'Đã thanh toán',
              createdBy: userId,
              usedForFinancialReporting: 1,
              customerDebtSnapshot: null,
            },
          });

          cashFlowIdsToUpdate.push(cashFlow.id);

          await tx.invoicePayment.create({
            data: {
              code: paymentCode,
              invoiceId: invoice.id,
              amount: payment.amount,
              paymentDate: new Date(),
              paymentMethod: payment.method,
              description: `Thanh toán thêm khi tạo hóa đơn ${invoice.code}`,
              status: 1,
              cashFlowId: cashFlow.id,
            },
          });
        }
      }

      for (const item of itemsToInvoice) {
        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: order.branchId },
          data: { onHand: { decrement: item.quantity } },
        });
      }

      const allInvoicedQty: Record<number, number> = {};
      const updatedInvoices = await tx.invoice.findMany({
        where: { orderId: order.id, status: { not: INVOICE_STATUS.CANCELLED } },
        include: { details: true },
      });
      updatedInvoices.forEach((inv) => {
        inv.details.forEach((d) => {
          allInvoicedQty[d.productId] =
            (allInvoicedQty[d.productId] || 0) + Number(d.quantity);
        });
      });

      await this.ordersService['updateOrderStatusByInvoices'](order.id, tx);

      if (order.customerId) {
        await this.updateCustomerTotals(order.customerId, tx);

        const updatedCustomer = await tx.customer.findUnique({
          where: { id: order.customerId },
          select: { totalDebt: true },
        });

        const finalCustomerDebtSnapshot = updatedCustomer
          ? Number(updatedCustomer.totalDebt)
          : null;

        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            customerDebtSnapshot: finalCustomerDebtSnapshot,
          },
        });

        if (cashFlowIdsToUpdate.length > 0) {
          await tx.cashFlow.updateMany({
            where: {
              id: { in: cashFlowIdsToUpdate },
            },
            data: {
              customerDebtSnapshot: finalCustomerDebtSnapshot,
            },
          });
        }
      }

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          details: true,
          payments: true,
          delivery: true,
          customer: true,
          branch: true,
          soldBy: true,
          order: { select: { code: true } },
        },
      });
    });
  }

  private hasProductChanges(oldDetails: any[], newItems: any[]): boolean {
    if (oldDetails.length !== newItems.length) return true;

    const oldMap = new Map(
      oldDetails.map((d) => [d.productId, Number(d.quantity)]),
    );
    const newMap = new Map(
      newItems.map((i) => [i.productId, Number(i.quantity)]),
    );

    if (oldMap.size !== newMap.size) return true;

    for (const [productId, oldQty] of oldMap) {
      const newQty = newMap.get(productId);
      if (newQty === undefined || newQty !== oldQty) return true;
    }

    return false;
  }

  private async generateInvoiceCodeWithSuffix(
    baseCode: string,
    tx: any,
  ): Promise<string> {
    const basePart = baseCode.match(/^(HD\d{6})/)?.[1] || baseCode;

    const existingVersions = await tx.invoice.findMany({
      where: {
        code: { startsWith: basePart },
      },
      select: { code: true },
    });

    const suffixes = existingVersions
      .map((inv) => {
        const match = inv.code.match(/\.(\d+)$/);
        return match ? parseInt(match[1]) : 0;
      })
      .filter((s) => s > 0);

    const nextSuffix = suffixes.length > 0 ? Math.max(...suffixes) + 1 : 1;
    return `${basePart}.${String(nextSuffix).padStart(2, '0')}`;
  }

  private async generateSafeInvoiceCode(tx: any): Promise<string> {
    const prefix = 'HD';
    const regex = new RegExp(`^${prefix}\\d{6}$`);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const allInvoices = await tx.invoice.findMany({
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

      const validCodes = allInvoices
        .map((inv: any) => inv.code)
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

      const exists = await tx.invoice.findFirst({
        where: { code },
      });

      if (!exists) {
        return code;
      }

      attempts++;
    }

    throw new Error('Không thể tạo mã hóa đơn duy nhất');
  }

  async findUnpaidByPartner(partnerId: number, partnerType: string) {
    if (partnerType !== 'C' && partnerType !== 'S') {
      return { data: [] };
    }

    const where: any = {
      status: {
        notIn: [INVOICE_STATUS.CANCELLED],
      },
      debtAmount: {
        gt: 0,
      },
    };

    if (partnerType === 'C') {
      where.customerId = partnerId;
    } else {
      return { data: [] };
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        grandTotal: true,
        paidAmount: true,
        debtAmount: true,
        status: true,
        statusValue: true,
      },
      orderBy: {
        purchaseDate: 'desc',
      },
    });

    return { data: invoices };
  }

  async getPaymentHistory(invoiceId: number) {
    const payments = await this.prisma.invoicePayment.findMany({
      where: { invoiceId },
      include: {
        cashFlow: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return payments;
  }

  private buildProductChangesLog(
    oldDetails: any[],
    newItems: any[],
  ): {
    cancelLog: string;
    newLog: string;
  } {
    const oldMap = new Map(
      oldDetails.map((d) => [
        d.productId,
        {
          code: d.productCode,
          quantity: Number(d.quantity),
          price: Number(d.price),
        },
      ]),
    );

    const newMap = new Map(
      newItems.map((i) => [
        i.productId,
        {
          code: i.productCode,
          quantity: Number(i.quantity),
          price: Number(i.price),
        },
      ]),
    );

    const removed: string[] = [];
    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const [productId, oldData] of oldMap) {
      const newData = newMap.get(productId);
      if (!newData) {
        removed.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)} (Đã xóa)`,
        );
      } else if (oldData.quantity !== newData.quantity) {
        changed.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)} → ${newData.quantity}*${new Intl.NumberFormat('vi-VN').format(newData.price)}`,
        );
      } else {
        unchanged.push(
          `${oldData.code} : ${oldData.quantity}*${new Intl.NumberFormat('vi-VN').format(oldData.price)}`,
        );
      }
    }

    for (const [productId, newData] of newMap) {
      if (!oldMap.has(productId)) {
        added.push(
          `${newData.code} : ${newData.quantity}*${new Intl.NumberFormat('vi-VN').format(newData.price)} (Mới thêm)`,
        );
      }
    }

    const cancelParts: string[] = [];
    if (unchanged.length > 0) {
      cancelParts.push(...unchanged);
    }
    if (changed.length > 0) {
      cancelParts.push(...changed.map((c) => c.split(' → ')[0]));
    }
    if (removed.length > 0) {
      cancelParts.push(...removed);
    }

    const newParts: string[] = [];
    if (unchanged.length > 0) {
      newParts.push(...unchanged);
    }
    if (changed.length > 0) {
      newParts.push(...changed.map((c) => c.split(' → ')[1]));
    }
    if (added.length > 0) {
      newParts.push(...added);
    }

    let changesSummary = '\n\nThay đổi:';
    if (removed.length > 0) {
      changesSummary += `\n- Đã xóa: ${removed.length} sản phẩm\n  ${removed.join('\n  ')}`;
    }
    if (added.length > 0) {
      changesSummary += `\n- Mới thêm: ${added.length} sản phẩm\n  ${added.join('\n  ')}`;
    }
    if (changed.length > 0) {
      changesSummary += `\n- Thay đổi số lượng: ${changed.length} sản phẩm\n  ${changed.join('\n  ')}`;
    }

    return {
      cancelLog: cancelParts.join('\n- ') + changesSummary,
      newLog: newParts.join('\n- '),
    };
  }
}
