import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
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
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';

@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: InvoiceQueryDto, currentUser?: any) {
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
      deliveryStatus,
      paymentMethod,
      bankAccountIds,
      fromPurchaseDate,
      toPurchaseDate,
      fromCreatedDate,
      toCreatedDate,
    } = query;

    const effectiveLimit = pageSize || limit;
    const effectiveSkip =
      currentItem !== undefined ? currentItem : (page - 1) * effectiveLimit;

    const where: any = {};

    if (currentUser && !currentUser.canViewOtherStaffData) {
      where.createdBy = currentUser.id;
    }

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

    if (query.parentCustomerId) {
      where.parentCustomerId = query.parentCustomerId;
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

    if (deliveryStatus === 'none') {
      where.delivery = { is: null };
    } else if (deliveryStatus === 'pending') {
      where.delivery = { is: { status: 1 } };
    } else if (deliveryStatus === 'delivered') {
      where.delivery = { is: { status: { not: 1 } } };
    }

    if (paymentMethod) {
      const paymentWhere: any = { paymentMethod };
      if (bankAccountIds && bankAccountIds.length > 0) {
        paymentWhere.accountId = { in: bankAccountIds };
      }
      where.payments = { some: paymentWhere };
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
          returnOrders: {
            where: {
              status: { gte: 2 }, // Đã nhập kho trở lên
              code: { startsWith: 'TH' }, // CHỈ LẤY PHIẾU TRẢ HÀNG, KHÔNG LẤY CTN
            },
            select: {
              id: true,
              code: true,
              status: true,
              refundAmount: true,
              refundedAmount: true,
              refundType: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    // Tính toán 4 trường mới cho mỗi invoice
    const dataWithReturnCalculations = data.map((invoice) => {
      const returnSummary = this.calculateReturnSummary(
        invoice.returnOrders || [],
        Number(invoice.grandTotal),
        Number(invoice.paidAmount),
      );

      return {
        ...invoice,
        returnOrderAmount: returnSummary.returnOrderAmount,
        cashRefundAmount: returnSummary.cashRefundAmount,
        debtOffsetAmount: returnSummary.debtOffsetAmount,
        remainingAmount: returnSummary.remainingAmount,
      };
    });

    return { data: dataWithReturnCalculations, total };
  }

  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: {
          include: {
            addresses: {
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
        branch: true,
        soldBy: true,
        creator: true,
        details: { include: { product: true } },
        payments: true,
        delivery: true,
        _count: { select: { returnOrders: true } },
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
            select: { id: true, totalDebt: true, name: true },
          })
        : null;

      const parentCustomerId = customer ? customer.id : null;

      const currentCustomerDebt = Number(customer?.totalDebt || 0);
      const customerDebtSnapshot = currentCustomerDebt + debtAmount;

      let priceBook: any = null;

      if (dto.priceBookId && dto.priceBookId > 0) {
        priceBook = await tx.priceBook.findFirst({
          where: { id: dto.priceBookId, isActive: true },
        });
      } else if (dto.priceBookId === undefined || dto.priceBookId === null) {
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
        priceBook = applicablePriceBooks[0] || null;
      }
      // dto.priceBookId === 0 → "Bảng giá chung" → priceBook giữ null

      const invoice = await tx.invoice.create({
        data: {
          code,
          customerId: dto.customerId,
          parentCustomerId,
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

      const branch = await this.prisma.branch.findUnique({
        where: { id: dto.branchId },
        select: { id: true, name: true },
      });

      for (const item of dto.items) {
        const invSnapshot = await tx.inventory.findFirst({
          where: { productId: item.productId, branchId: dto.branchId },
        });

        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: dto.branchId },
          data: { onHand: { decrement: item.quantity } },
        });

        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            productCode: item.productCode || '',
            productName: item.productName || '',
            branchId: dto.branchId!,
            branchName: branch?.name || '',
            transactionType: 'SALE',
            refCode: invoice.code,
            refType: 'invoice',
            refId: invoice.id,
            quantity: -Number(item.quantity),
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
            transactionPrice: Number(item.price),
            partnerId: dto.customerId || null,
            partnerName: customer?.name,
          },
        });
      }

      if (dto.customerId) {
        await this.updateCustomerTotals(dto.customerId, tx);
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      const orderCode = await tx.order.findUnique({
        where: { id: Number(invoice.orderId) },
        select: { code: true },
      });

      const customerName = await tx.customer.findUnique({
        where: { id: Number(invoice.customerId) },
        select: { name: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVOICE_CREATE',
        entityType: 'invoices',
        entityId: invoice.id.toString(),
        entityCode: invoice.code,
        category: getCategoryFromActionCode('INVOICE_CREATE'),
        severity: getSeverityFromActionCode('INVOICE_CREATE'),
        snapshot: this.buildInvoiceSnapshot(invoice),
        message: renderAuditMessage('INVOICE_CREATE', {
          invoiceCode: invoice.code,
          orderCode: orderCode || '',
          customerName: customerName || '',
        }),
        messageTemplate: 'INVOICE_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: invoice.branchId || undefined,
      });

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
          category: getCategoryFromActionCode('INVOICE_CANCEL'),
          severity: getSeverityFromActionCode('INVOICE_CANCEL'),
          snapshot: this.buildInvoiceSnapshot(currentInvoice),
          message: renderAuditMessage('INVOICE_CANCEL', {
            invoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_CANCEL',
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

        const cancelCustomerId = dto.customerId ?? currentInvoice.customerId;
        const cancelParentCustomerId = cancelCustomerId;

        // Xác định priceBook cho hóa đơn mới
        let newPriceBookId = currentInvoice.priceBookId;
        let newPriceBookName = currentInvoice.priceBookName;

        if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
          if (dto.priceBookId > 0) {
            const priceBook = await tx.priceBook.findFirst({
              where: { id: dto.priceBookId, isActive: true },
            });
            newPriceBookId = priceBook?.id || null;
            newPriceBookName = priceBook?.name || null;
          } else {
            // dto.priceBookId === 0 → "Bảng giá chung"
            newPriceBookId = null;
            newPriceBookName = null;
          }
        }

        const newInvoice = await tx.invoice.create({
          data: {
            code: newCode,
            orderId: currentInvoice.orderId,
            customerId: dto.customerId ?? currentInvoice.customerId,
            parentCustomerId: cancelParentCustomerId,
            branchId: dto.branchId ?? currentInvoice.branchId,
            soldById: dto.soldById ?? currentInvoice.soldById,
            saleChannelId: currentInvoice.saleChannelId,
            priceBookId: newPriceBookId,
            priceBookName: newPriceBookName,
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
          const invSnapshot = await tx.inventory.findFirst({
            where: {
              productId: item.productId,
              branchId: newInvoice.branchId || 1,
            },
          });

          await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              branchId: newInvoice.branchId || 1,
            },
            data: { onHand: { decrement: item.quantity } },
          });

          await tx.inventoryLog.create({
            data: {
              productId: item.productId,
              productCode: item.productCode || '',
              productName: item.productName || '',
              branchId: newInvoice.branchId || 1,
              branchName: newInvoice.branch?.name || '',
              transactionType: 'SALE',
              refCode: newInvoice.code,
              refType: 'invoice',
              refId: newInvoice.id,
              quantity: -Number(item.quantity),
              costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
              transactionPrice: Number(item.price),
              partnerId: newInvoice.customerId || null,
              partnerName: newInvoice.customer?.name || null,
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
          category: getCategoryFromActionCode('INVOICE_CREATE_FROM_CANCELLED'),
          severity: getSeverityFromActionCode('INVOICE_CREATE_FROM_CANCELLED'),
          snapshot: this.buildInvoiceSnapshot(newInvoice),
          message: renderAuditMessage('INVOICE_CREATE_FROM_CANCELLED', {
            invoiceCode: newCode,
            oldInvoiceCode: currentInvoice.code,
          }),
          messageTemplate: 'INVOICE_CREATE_FROM_CANCELLED',
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
          if (currentInvoice.status === INVOICE_STATUS.COMPLETED) {
            const actor = userId
              ? await tx.user.findUnique({
                  where: { id: userId },
                  include: { userRoles: { include: { role: true } } },
                })
              : null;
            const isAdmin = actor?.userRoles?.some(
              (ur: any) =>
                ur.role.name === 'Admin' || ur.role.name === 'Super Admin',
            );
            if (!isAdmin) {
              throw new ForbiddenException(
                'Chỉ Admin mới được phép hủy hóa đơn hoàn thành',
              );
            }
          }

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

      // Xử lý items khi chỉ thay đổi giá (cùng sản phẩm, cùng số lượng)
      if (
        dto.items &&
        (!dto.status || dto.status !== INVOICE_STATUS.CANCELLED)
      ) {
        await tx.invoiceDetail.deleteMany({ where: { invoiceId: id } });

        const totalAmount = dto.items.reduce(
          (sum, item) => sum + item.totalPrice,
          0,
        );
        const discountAmount = dto.discountAmount || 0;
        const discountFromRatio =
          (totalAmount * (dto.discountRatio || 0)) / 100;
        const grandTotal = totalAmount - discountAmount - discountFromRatio;

        const payments = await tx.invoicePayment.findMany({
          where: { invoiceId: id },
        });
        const paidAmount = payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
        const debtAmount = grandTotal - paidAmount;

        let status: number = currentInvoice.status;
        if (
          status !== INVOICE_STATUS.CANCELLED &&
          status !== INVOICE_STATUS.FAILED_DELIVERY
        ) {
          status =
            debtAmount <= 0
              ? INVOICE_STATUS.COMPLETED
              : INVOICE_STATUS.PROCESSING;
        }

        updateData.totalAmount = totalAmount;
        updateData.discount = discountAmount;
        updateData.discountRatio = dto.discountRatio || 0;
        updateData.grandTotal = grandTotal;
        updateData.debtAmount = debtAmount;
        updateData.paidAmount = paidAmount;
        updateData.status = status;
        updateData.statusValue = getStatusLabel(status);

        updateData.details = {
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
        };
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

      if (dto.priceBookId !== undefined && dto.priceBookId !== null) {
        // User chủ động chọn bảng giá từ dropdown
        if (dto.priceBookId > 0) {
          const priceBook = await tx.priceBook.findFirst({
            where: { id: dto.priceBookId, isActive: true },
          });
          updateData.priceBookId = priceBook?.id || null;
          updateData.priceBookName = priceBook?.name || null;
        } else {
          // dto.priceBookId === 0 → "Bảng giá chung"
          updateData.priceBookId = null;
          updateData.priceBookName = null;
        }
      } else {
        // priceBookId không gửi → auto-detect nếu context thay đổi
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

      // Cập nhật lại công nợ khách hàng khi items thay đổi giá
      if (dto.items && !shouldUpdateCustomerDebt && currentInvoice.customerId) {
        await this.updateCustomerTotals(currentInvoice.customerId, tx);
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
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });

    if (!customer) return;

    const invoices = await tx.invoice.findMany({
      where: {
        customerId,
        status: { notIn: [2] },
      },
    });

    const totalGrandTotal = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );
    const totalPurchased = totalGrandTotal;

    const cashFlowsReceipt = await tx.cashFlow.findMany({
      where: {
        partnerId: customerId,
        partnerType: 'C',
        isReceipt: true,
        status: { not: 2 },
        code: { not: { startsWith: 'TTTUHD' } },
      },
      select: { amount: true },
    });
    const totalCashFlowReceived = cashFlowsReceipt.reduce(
      (sum: number, cf: any) => sum + Number(cf.amount),
      0,
    );

    const cashFlowsPaidOut = await tx.cashFlow.findMany({
      where: {
        partnerId: customerId,
        partnerType: 'C',
        isReceipt: false,
        status: { not: 2 },
      },
      select: { amount: true },
    });
    const totalCashFlowPaidOut = cashFlowsPaidOut.reduce(
      (sum: number, cf: any) => sum + Number(cf.amount),
      0,
    );

    // Tổng cấn trừ công nợ từ phiếu trả hàng
    // - status=2 (STOCK_RECEIVED): confirmStockReceived đã trực tiếp giảm totalDebt
    // - status=4 + debt_offset: đã hoàn thành, cấn trừ vĩnh viễn
    // - status=4 + cash_refund: Bước 2 đã trừ nguyên refundAmount khỏi totalDebt;
    //   Bước 3 cộng lại effectiveRefundAmount qua CHI-TH (nằm trong totalCashFlowPaidOut).
    // - Không tính manual_offset vì CTN không đụng totalDebt
    const debtOffsets = await tx.returnOrder.findMany({
      where: {
        customerId,
        OR: [
          { status: 2 },
          { status: 4, refundType: 'debt_offset' },
          { status: 4, refundType: 'cash_refund' },
        ],
      },
      select: { refundAmount: true },
    });
    const totalDebtOffsets = debtOffsets.reduce(
      (sum: number, ro: any) => sum + Number(ro.refundAmount),
      0,
    );

    const totalDebt =
      totalGrandTotal -
      totalCashFlowReceived +
      totalCashFlowPaidOut -
      totalDebtOffsets;

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
              totalDebt: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
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

      const orderCustomer = order.customerId
        ? await tx.customer.findUnique({
            where: { id: order.customerId },
            select: { id: true },
          })
        : null;

      const parentCustomerId = orderCustomer ? orderCustomer.id : null;

      const invoice = await tx.invoice.create({
        data: {
          code,
          orderId: order.id,
          customerId: order.customerId,
          parentCustomerId,
          branchId: order.branchId,
          soldById: dto.soldById ?? order.soldById,
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
          customer: {
            include: {
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { address: true },
              },
            },
          },
          priceBook: true,
        },
      });

      const soldByName = await this.prisma.user.findUnique({
        where: { id: Number(order.soldById) },
        select: { name: true },
      });

      const createdByName = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      const invoiceData = invoice;

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
              address: invoice.customer?.addresses?.[0]?.address || null,
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
              address: invoice.customer?.addresses?.[0]?.address || null,
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

      const branch = await this.prisma.branch.findUnique({
        where: { id: order.branchId },
        select: { id: true, name: true },
      });

      for (const item of itemsToInvoice) {
        const invSnapshot = await tx.inventory.findFirst({
          where: { productId: item.productId, branchId: order.branchId },
        });

        await tx.inventory.updateMany({
          where: { productId: item.productId, branchId: order.branchId },
          data: { onHand: { decrement: item.quantity } },
        });

        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            productCode: item.productCode || '',
            productName: item.productName || '',
            branchId: order.branchId,
            branchName: branch?.name || '',
            transactionType: 'SALE',
            refCode: invoice.code,
            refType: 'invoice',
            refId: invoice.id,
            quantity: -Number(item.quantity),
            costPrice: invSnapshot ? Number(invSnapshot.cost) : 0,
            transactionPrice: Number(item.price),
            partnerId: order.customerId || null,
            partnerName: order.customer?.name || null,
          },
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

        const targetDebtCustomerId = order.customerId;
        const updatedCustomer = targetDebtCustomerId
          ? await tx.customer.findUnique({
              where: { id: targetDebtCustomerId },
              select: { totalDebt: true },
            })
          : null;

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

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'INVOICE_CREATE',
        entityType: 'invoices',
        entityId: invoice.id.toString(),
        entityCode: invoice.code,
        category: getCategoryFromActionCode('INVOICE_CREATE'),
        severity: getSeverityFromActionCode('INVOICE_CREATE'),
        snapshot: this.buildInvoiceSnapshot(
          invoiceData,
          order,
          soldByName,
          createdByName,
        ),
        message: renderAuditMessage('INVOICE_CREATE', {
          invoiceCode: invoice.code,
          orderCode: order.code,
          customerName: invoice.customer?.name || 'N/A',
        }),
        messageTemplate: 'INVOICE_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: invoice.branchId || undefined,
      });

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

  async findForReturnOrder(query: {
    search?: string;
    branchId?: number;
    limit?: number;
  }) {
    const { search, branchId, limit = 20 } = query;

    const where: any = {
      status: {
        in: [
          INVOICE_STATUS.COMPLETED,
          INVOICE_STATUS.PROCESSING,
          INVOICE_STATUS.PACKED,
          INVOICE_STATUS.LOADING,
          INVOICE_STATUS.DELIVERED,
        ],
      },
    };

    if (branchId) {
      where.branchId = branchId;
    }

    if (search) {
      where.OR = [
        { code: { contains: search } },
        { customer: { name: { contains: search } } },
      ];
    }

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: {
        details: true,
        customer: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (invoices.length === 0) return [];

    const invoiceIds = invoices.map((inv) => inv.id);

    const existingReturns = await this.prisma.returnOrder.findMany({
      where: {
        status: { notIn: [5] },
        details: {
          some: { invoiceId: { in: invoiceIds } },
        },
      },
      select: {
        details: {
          where: { invoiceId: { in: invoiceIds } },
          select: { invoiceId: true, productId: true, requestQuantity: true },
        },
      },
    });

    const returnedMap: Record<string, number> = {};
    existingReturns.forEach((ro) => {
      ro.details.forEach((d) => {
        const key = `${d.invoiceId}-${d.productId}`;
        returnedMap[key] = (returnedMap[key] || 0) + Number(d.requestQuantity);
      });
    });

    return invoices.filter((inv) => {
      if (!inv.details || inv.details.length === 0) return false;
      return inv.details.some((d) => {
        const key = `${inv.id}-${d.productId}`;
        const returned = returnedMap[key] || 0;
        return Number(d.quantity) - returned > 0;
      });
    });
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

  private calculateReturnSummary(
    returnOrders: any[],
    grandTotal: number,
    paidAmount: number,
  ) {
    let totalReturnAmount = 0;
    let totalCashRefund = 0;
    let totalDebtOffset = 0;

    // CHỈ XỬ LÝ ReturnOrder có code bắt đầu bằng 'TH' (phiếu trả hàng)
    // Không tính CTN (cấn trừ nợ từ modal thanh toán) vì đã được tính vào paidAmount
    for (const ro of returnOrders) {
      if (!ro.code || !ro.code.startsWith('TH')) continue;

      const refundAmount = Number(ro.refundAmount || 0);

      // Trả hàng: Tổng refundAmount từ các phiếu đã nhập kho (status >= 2)
      if (ro.status >= 2) {
        totalReturnAmount += refundAmount;
      }

      // Phiếu chi: refundedAmount từ phiếu với refundType = 'cash_refund' (status = 4)
      if (ro.status === 4 && ro.refundType === 'cash_refund') {
        totalCashRefund += Number(ro.refundedAmount || 0);
      }

      // Cấn trừ nợ: refundAmount từ phiếu với refundType = 'debt_offset' (status = 4)
      if (ro.status === 4 && ro.refundType === 'debt_offset') {
        totalDebtOffset += refundAmount;
      }
    }

    // Credit = phần trả hàng vượt quá khoản nợ ban đầu (tiền khách đã trả, được hoàn lại)
    // Với hóa đơn chưa trả: debtBeforeReturn = grandTotal → credit = 0 → effectiveDebtOffset = 0
    // Với hóa đơn đã trả: debtBeforeReturn = 0 → credit = totalReturnAmount → effectiveDebtOffset = totalDebtOffset
    const debtBeforeReturn = grandTotal - paidAmount;
    const credit = Math.max(0, totalReturnAmount - debtBeforeReturn);
    const effectiveDebtOffset = Math.min(totalDebtOffset, credit);

    // Cấn trừ nợ chỉ hiển thị khi hóa đơn có thanh toán trước (paidAmount > 0)
    // Với hóa đơn chưa trả: "Trả hàng" đã đại diện cho việc giảm nợ rồi
    const displayDebtOffset = paidAmount > 0 ? -effectiveDebtOffset : 0;

    const remainingAmount =
      grandTotal -
      paidAmount -
      totalReturnAmount +
      totalCashRefund +
      effectiveDebtOffset;

    return {
      returnOrderAmount: totalReturnAmount,
      cashRefundAmount: totalCashRefund,
      debtOffsetAmount: effectiveDebtOffset,
      remainingAmount,
    };
  }

  private buildInvoiceSnapshot(
    invoice: any,
    order?: any,
    soldByName?: any,
    createdByName?: any,
  ) {
    return {
      code: invoice.code,
      purchaseDate: invoice.purchaseDate,
      statusValue: invoice.statusValue,
      grandTotal: Number(invoice.grandTotal),
      totalAmount: Number(invoice.totalAmount || 0),
      discount: Number(invoice.discount || 0),
      discountRatio: Number(invoice.discountRatio || 0),
      paidAmount: Number(invoice.paidAmount || 0),
      debtAmount: Number(invoice.debtAmount || 0),
      description: invoice.description,
      usingCod: invoice.usingCod,
      priceBookName: invoice.priceBookName || invoice.priceBook?.name || null,
      customer: invoice.customer
        ? { code: invoice.customer.code, name: invoice.customer.name }
        : null,
      order: order,
      soldBy: soldByName,
      branch: invoice.branch ? { name: invoice.branch.name } : null,
      items: (invoice.details || []).map((i: any) => ({
        productId: i.productId,
        productCode: i.productCode || i.product?.code,
        productName: i.productName || i.product?.name,
        quantity: Number(i.quantity),
        price: Number(i.price),
        discount: Number(i.discount || 0),
        isRewardPoint: i.isRewardPoint,
      })),
      delivery: invoice.delivery
        ? {
            receiver: invoice.delivery.receiver,
            contactNumber: invoice.delivery.contactNumber,
            address: invoice.delivery.address,
            wardName: invoice.delivery.wardName,
            weight: invoice.delivery.weight,
            length: invoice.delivery.length,
            width: invoice.delivery.width,
            height: invoice.delivery.height,
            price: invoice.delivery.price,
            noteForDriver: invoice.delivery.noteForDriver,
            statusValue: invoice.delivery.statusValue,
          }
        : null,
    };
  }
}
