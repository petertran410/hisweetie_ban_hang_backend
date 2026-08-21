import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicApiListQueryDto } from './dto/public-api-list-query.dto';
import { PublicCustomerLedgerQueryDto } from './dto/public-customer-ledger-query.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type Resource =
  | 'branches'
  | 'customer-types'
  | 'customer-groups'
  | 'customers'
  | 'products'
  | 'inventories'
  | 'orders'
  | 'invoices'
  | 'return-orders'
  | 'categories'
  | 'trademarks'
  | 'sale-channels'
  | 'bank-accounts'
  | 'users'
  | 'suppliers'
  | 'supplier-groups'
  | 'price-books'
  | 'purchase-orders'
  | 'transfers'
  | 'cashflows'
  | 'surchages'
  | 'locations'
  | 'settings'
  | 'order-suppliers'
  | 'consignments'
  | 'supplier-returns';

/** Nguồn sự thật duy nhất về tên resource, dùng chung cho REST và webhook. */
export const PUBLIC_API_RESOURCES: readonly Resource[] = [
  'branches',
  'customer-types',
  'customer-groups',
  'customers',
  'products',
  'inventories',
  'orders',
  'invoices',
  'return-orders',
  'categories',
  'trademarks',
  'sale-channels',
  'bank-accounts',
  'users',
  'suppliers',
  'supplier-groups',
  'price-books',
  'purchase-orders',
  'transfers',
  'cashflows',
  'surchages',
  'locations',
  'settings',
  'order-suppliers',
  'consignments',
  'supplier-returns',
];

@Injectable()
export class PublicApiService {
  constructor(private readonly prisma: PrismaService) {}

  assertResource(resource: string): Resource {
    if (!(PUBLIC_API_RESOURCES as readonly string[]).includes(resource)) {
      throw new BadRequestException(
        `Unsupported public API resource: ${resource}`,
      );
    }
    return resource as Resource;
  }

  async listCustomerAddresses(customerId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Resource not found');

    const data = await this.prisma.customerAddress.findMany({
      where: { customerId },
      select: {
        id: true,
        label: true,
        receiver: true,
        contactNumber: true,
        address: true,
        cityCode: true,
        cityName: true,
        districtCode: true,
        districtName: true,
        wardCode: true,
        wardName: true,
        newCityCode: true,
        newCityName: true,
        newWardCode: true,
        newWardName: true,
        locationName: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return {
      total: data.length,
      data: this.toJson(data),
      timestamp: new Date().toISOString(),
    };
  }

  async listCustomerGroupMemberships(customerId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Resource not found');

    const rows = await this.prisma.customerGroupDetail.findMany({
      where: { customerId },
      select: {
        id: true,
        customerGroup: {
          select: {
            id: true,
            name: true,
            description: true,
            discount: true,
            createdAt: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    return {
      total: rows.length,
      data: this.toJson(
        rows.map((row) => ({ membershipId: row.id, ...row.customerGroup })),
      ),
      timestamp: new Date().toISOString(),
    };
  }

  async listOrderPayments(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Resource not found');
    const data = await this.prisma.orderPayment.findMany({
      where: { orderId },
      select: {
        id: true,
        code: true,
        amount: true,
        paymentDate: true,
        paymentMethod: true,
        status: true,
        statusValue: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
    });
    return {
      total: data.length,
      data: this.toJson(data),
      timestamp: new Date().toISOString(),
    };
  }

  async listInvoicePayments(invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundException('Resource not found');
    const data = await this.prisma.invoicePayment.findMany({
      where: { invoiceId },
      select: {
        id: true,
        code: true,
        amount: true,
        paymentDate: true,
        paymentMethod: true,
        status: true,
        statusValue: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
    });
    return {
      total: data.length,
      data: this.toJson(data),
      timestamp: new Date().toISOString(),
    };
  }

  async getOrderDelivery(orderId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        delivery: {
          select: {
            id: true,
            deliveryCode: true,
            type: true,
            status: true,
            statusValue: true,
            price: true,
            receiver: true,
            contactNumber: true,
            address: true,
            locationName: true,
            wardName: true,
            newCityName: true,
            newWardName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Resource not found');
    return {
      data: this.toJson(order.delivery),
      timestamp: new Date().toISOString(),
    };
  }

  async getInvoiceDelivery(invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        delivery: {
          select: {
            id: true,
            deliveryCode: true,
            type: true,
            status: true,
            statusValue: true,
            price: true,
            receiver: true,
            contactNumber: true,
            address: true,
            locationName: true,
            wardName: true,
            newCityName: true,
            newWardName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Resource not found');
    return {
      data: this.toJson(invoice.delivery),
      timestamp: new Date().toISOString(),
    };
  }

  async getCustomerLedger(
    customerId: number,
    query: PublicCustomerLedgerQueryDto,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, code: true, name: true, totalDebt: true },
    });
    if (!customer) throw new NotFoundException('Resource not found');

    const from = query.fromDate ? new Date(query.fromDate) : undefined;
    const to = query.toDate ? new Date(query.toDate) : undefined;
    const dateRange = (field: string) => ({
      ...(from || to
        ? {
            [field]: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    });
    const allowedTypes = new Set(
      (query.types || '')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean),
    );
    const accepts = (type: string) =>
      !allowedTypes.size || allowedTypes.has(type);
    const entries: Array<Record<string, any>> = [];

    const [invoices, cashFlows, returns] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { customerId, status: { not: 2 }, ...dateRange('purchaseDate') },
        select: {
          id: true,
          code: true,
          purchaseDate: true,
          grandTotal: true,
          status: true,
          statusValue: true,
          createdAt: true,
        },
      }),
      this.prisma.cashFlow.findMany({
        where: {
          partnerType: 'C',
          partnerId: customerId,
          status: { not: 2 },
          NOT: [{ code: { startsWith: 'TTTUHD' } }],
          ...dateRange('transDate'),
        },
        select: {
          id: true,
          code: true,
          isReceipt: true,
          amount: true,
          transDate: true,
          method: true,
          status: true,
          statusValue: true,
          createdAt: true,
        },
      }),
      this.prisma.returnOrder.findMany({
        where: {
          customerId,
          status: { in: [1, 2, 3, 4] },
          ...dateRange('createdAt'),
        },
        select: {
          id: true,
          code: true,
          status: true,
          statusValue: true,
          refundAmount: true,
          refundType: true,
          confirmedAt: true,
          refundConfirmedAt: true,
          createdAt: true,
        },
      }),
    ]);

    if (accepts('invoice')) {
      for (const invoice of invoices)
        entries.push({
          type: 'invoice',
          reference: invoice.code,
          sourceId: invoice.id,
          date: invoice.purchaseDate,
          createdAt: invoice.createdAt,
          amount: Number(invoice.grandTotal),
          direction: 'debit',
          status: invoice.statusValue || String(invoice.status),
          description: 'Bán hàng',
        });
    }
    for (const cashFlow of cashFlows) {
      const type = cashFlow.isReceipt ? 'payment' : 'refund';
      if (accepts(type))
        entries.push({
          type,
          reference: cashFlow.code,
          sourceId: cashFlow.id,
          date: cashFlow.transDate,
          createdAt: cashFlow.createdAt,
          amount: Number(cashFlow.amount),
          direction: cashFlow.isReceipt ? 'credit' : 'debit',
          status: cashFlow.statusValue || String(cashFlow.status),
          description: cashFlow.isReceipt ? 'Thanh toán' : 'Hoàn tiền',
        });
    }
    if (accepts('return')) {
      for (const returnOrder of returns)
        entries.push({
          type: 'return',
          reference: returnOrder.code,
          sourceId: returnOrder.id,
          date:
            returnOrder.refundConfirmedAt ||
            returnOrder.confirmedAt ||
            returnOrder.createdAt,
          createdAt: returnOrder.createdAt,
          amount: Number(returnOrder.refundAmount),
          direction: 'credit',
          status: returnOrder.statusValue || String(returnOrder.status),
          description: 'Trả hàng',
        });
    }

    const typeOrder: Record<string, number> = {
      invoice: 0,
      refund: 1,
      return: 2,
      payment: 3,
    };
    entries.sort(
      (left, right) =>
        new Date(left.date).getTime() - new Date(right.date).getTime() ||
        typeOrder[left.type] - typeOrder[right.type] ||
        new Date(left.createdAt).getTime() -
          new Date(right.createdAt).getTime() ||
        left.sourceId - right.sourceId,
    );
    let runningDebt = 0;
    for (const entry of entries) {
      runningDebt += entry.direction === 'debit' ? entry.amount : -entry.amount;
      entry.runningDebt = runningDebt;
    }
    entries.reverse();
    const pageSize = Math.min(
      Math.max(query.pageSize || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const currentItem = Math.max(query.currentItem || 0, 0);
    return {
      customer: this.toJson({
        id: customer.id,
        code: customer.code,
        name: customer.name,
        currentDebt: customer.totalDebt,
      }),
      total: entries.length,
      pageSize,
      currentItem,
      data: this.toJson(entries.slice(currentItem, currentItem + pageSize)),
      timestamp: new Date().toISOString(),
    };
  }

  async list(resource: Resource, query: PublicApiListQueryDto) {
    const pageSize = Math.min(
      Math.max(query.pageSize || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const currentItem = Math.max(query.currentItem || 0, 0);
    const branchIds = this.parseIds(query.branchIds);
    const customerIds = this.parseIds(query.customerIds);
    const include = new Set(
      (query.include || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );

    let result: { total: number; rows: any[] };
    switch (resource) {
      case 'branches':
        result = await this.listBranches(query, currentItem, pageSize);
        break;
      case 'customer-types':
        result = await this.listCustomerTypes(query, currentItem, pageSize);
        break;
      case 'customer-groups':
        result = await this.listCustomerGroups(query, currentItem, pageSize);
        break;
      case 'customers':
        result = await this.listCustomers(
          query,
          currentItem,
          pageSize,
          branchIds,
          include,
        );
        break;
      case 'products':
        result = await this.listProducts(query, currentItem, pageSize, include);
        break;
      case 'inventories':
        result = await this.listInventories(
          query,
          currentItem,
          pageSize,
          branchIds,
        );
        break;
      case 'orders':
        result = await this.listOrders(
          query,
          currentItem,
          pageSize,
          branchIds,
          customerIds,
          include,
        );
        break;
      case 'invoices':
        result = await this.listInvoices(
          query,
          currentItem,
          pageSize,
          branchIds,
          customerIds,
          include,
        );
        break;
      case 'return-orders':
        result = await this.listReturnOrders(
          query,
          currentItem,
          pageSize,
          branchIds,
          customerIds,
          include,
        );
        break;
      case 'categories':
        result = await this.listCategories(query, currentItem, pageSize);
        break;
      case 'trademarks':
        result = await this.listTradeMarks(query, currentItem, pageSize);
        break;
      case 'sale-channels':
        result = await this.listSaleChannels(query, currentItem, pageSize);
        break;
      case 'bank-accounts':
        result = await this.listBankAccounts(query, currentItem, pageSize);
        break;
      case 'users':
        result = await this.listUsers(query, currentItem, pageSize, branchIds);
        break;
      case 'suppliers':
        result = await this.listSuppliers(
          query,
          currentItem,
          pageSize,
          branchIds,
        );
        break;
      case 'supplier-groups':
        result = await this.listSupplierGroups(query, currentItem, pageSize);
        break;
      case 'price-books':
        result = await this.listPriceBooks(
          query,
          currentItem,
          pageSize,
          include,
        );
        break;
      case 'purchase-orders':
        result = await this.listPurchaseOrders(
          query,
          currentItem,
          pageSize,
          branchIds,
          include,
        );
        break;
      case 'transfers':
        result = await this.listTransfers(
          query,
          currentItem,
          pageSize,
          branchIds,
          include,
        );
        break;
      case 'cashflows':
        result = await this.listCashFlows(
          query,
          currentItem,
          pageSize,
          branchIds,
        );
        break;
      case 'surchages':
        result = await this.listSurcharges(query, currentItem, pageSize);
        break;
      case 'locations':
        result = await this.listLocations(query, currentItem, pageSize);
        break;
      case 'settings':
        result = await this.listSettings(query, currentItem, pageSize);
        break;
      case 'order-suppliers':
        result = await this.listOrderSuppliers(
          query,
          currentItem,
          pageSize,
          branchIds,
          include,
        );
        break;
      case 'consignments':
        result = await this.listConsignments(
          query,
          currentItem,
          pageSize,
          branchIds,
          customerIds,
          include,
        );
        break;
      case 'supplier-returns':
        result = await this.listSupplierReturns(
          query,
          currentItem,
          pageSize,
          branchIds,
          include,
        );
        break;
    }

    // Envelope theo tài liệu KiotViet Public API.
    return {
      total: result.total,
      pageSize,
      currentItem,
      data: result.rows.map((row) => this.mapResource(resource, row)),
      timestamp: new Date().toISOString(),
    };
  }

  async get(resource: Resource, id: number, includeParam?: string) {
    const include = new Set(
      (includeParam || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    let data: unknown;
    switch (resource) {
      case 'branches':
        data = await this.prisma.branch.findUnique({ where: { id } });
        break;
      case 'customer-types':
        data = await this.prisma.customerType.findUnique({ where: { id } });
        break;
      case 'customer-groups':
        data = await this.prisma.customerGroup.findUnique({ where: { id } });
        break;
      case 'customers':
        data = await this.prisma.customer.findUnique({
          where: { id },
          include: {
            addresses: true,
            customerGroupDetails: { include: { customerGroup: true } },
          },
        });
        break;
      case 'products':
        data = await this.prisma.product.findUnique({
          where: { id },
          include: {
            images: true,
            attributes: true,
            inventories: include.has('inventories'),
          },
        });
        break;
      case 'inventories':
        data = await this.prisma.inventory.findUnique({ where: { id } });
        break;
      case 'orders':
        data = await this.prisma.order.findUnique({
          where: { id },
          include: { items: true, payments: true, delivery: true },
        });
        break;
      case 'invoices':
        data = await this.prisma.invoice.findUnique({
          where: { id },
          include: { details: true, payments: true, delivery: true },
        });
        break;
      case 'return-orders':
        data = await this.prisma.returnOrder.findUnique({
          where: { id },
          include: { details: true },
        });
        break;
      case 'categories':
        data = await this.prisma.category.findUnique({ where: { id } });
        break;
      case 'trademarks':
        data = await this.prisma.tradeMark.findUnique({ where: { id } });
        break;
      case 'sale-channels':
        data = await this.prisma.saleChannel.findUnique({ where: { id } });
        break;
      case 'bank-accounts':
        data = await this.prisma.bankAccount.findUnique({ where: { id } });
        break;
      case 'users':
        data = await this.prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            avatar: true,
            branchId: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        break;
      case 'suppliers':
        data = await this.prisma.supplier.findUnique({ where: { id } });
        break;
      case 'supplier-groups':
        data = await this.prisma.supplierGroup.findUnique({ where: { id } });
        break;
      case 'price-books':
        data = await this.prisma.priceBook.findUnique({
          where: { id },
          include: { priceBookDetails: include.has('details') },
        });
        break;
      case 'purchase-orders':
        data = await this.prisma.purchaseOrder.findUnique({
          where: { id },
          include: { items: true },
        });
        break;
      case 'transfers':
        data = await this.prisma.transfer.findUnique({
          where: { id },
          include: { details: true },
        });
        break;
      case 'cashflows':
        data = await this.prisma.cashFlow.findUnique({ where: { id } });
        break;
      case 'surchages':
        data = await this.prisma.surcharge.findUnique({ where: { id } });
        break;
      case 'locations':
        data = await this.prisma.location.findUnique({ where: { id } });
        break;
      case 'settings':
        data = await this.prisma.settings.findUnique({ where: { id } });
        break;
      case 'order-suppliers':
        data = await this.prisma.orderSupplier.findUnique({
          where: { id },
          include: { items: true, payments: include.has('payments') },
        });
        break;
      case 'consignments':
        data = await this.prisma.consignment.findUnique({
          where: { id },
          include: { items: true, delivery: true },
        });
        break;
      case 'supplier-returns':
        data = await this.prisma.supplierReturn.findUnique({
          where: { id },
          include: { details: true },
        });
        break;
    }
    if (!data) throw new NotFoundException('Resource not found');
    return {
      data: this.mapResource(resource, data),
      timestamp: new Date().toISOString(),
    };
  }

  private async listBranches(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.includeInactive ? {} : { isActive: true },
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.branch.count({ where }),
      this.prisma.branch.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listCustomerTypes(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customerType.count({ where }),
      this.prisma.customerType.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listCustomerGroups(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customerGroup.count({ where }),
      this.prisma.customerGroup.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listCustomers(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        include: {
          addresses: include.has('addresses'),
          customerGroupDetails: include.has('groups')
            ? { include: { customerGroup: true } }
            : false,
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listProducts(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: {
          images: include.has('images'),
          attributes: include.has('attributes'),
          inventories: include.has('inventories'),
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listInventories(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
  ) {
    const where = this.timestampWhere(
      query,
      branchIds.length ? { branchId: { in: branchIds } } : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventory.count({ where }),
      this.prisma.inventory.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listOrders(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    customerIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(customerIds.length ? { customerId: { in: customerIds } } : {}),
      ...(query.status ? { orderStatus: { in: query.status.split(',') } } : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: {
          items: include.has('details'),
          payments: include.has('payments'),
          delivery: include.has('delivery'),
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listInvoices(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    customerIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(customerIds.length ? { customerId: { in: customerIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: {
          details: include.has('details'),
          payments: include.has('payments'),
          delivery: include.has('delivery'),
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listReturnOrders(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    customerIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(customerIds.length ? { customerId: { in: customerIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.returnOrder.count({ where }),
      this.prisma.returnOrder.findMany({
        where,
        include: { details: include.has('details') },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listCategories(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(query, {
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...(query.status
        ? {
            type: {
              in: query.status
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.category.count({ where }),
      this.prisma.category.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listTradeMarks(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.tradeMark.count({ where }),
      this.prisma.tradeMark.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSaleChannels(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    // Cột trạng thái của kênh bán tên là `isActivate`, không phải `isActive`.
    const where = this.timestampWhere(
      query,
      query.includeInactive ? {} : { isActivate: true },
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.saleChannel.count({ where }),
      this.prisma.saleChannel.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listBankAccounts(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.search
        ? {
            OR: [
              { bankName: { contains: query.search, mode: 'insensitive' } },
              {
                accountHolder: { contains: query.search, mode: 'insensitive' },
              },
            ],
          }
        : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.bankAccount.count({ where }),
      this.prisma.bankAccount.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listUsers(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
  ) {
    const where = this.timestampWhere(query, {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      // `select` tường minh: model User chứa mật khẩu và cờ phân quyền nội bộ,
      // dùng `findMany` trần rồi lọc sau rất dễ rò khi schema thêm cột mới.
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          avatar: true,
          branchId: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSuppliers(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
  ) {
    const where = this.timestampWhere(query, {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { contactNumber: { contains: query.search } },
            ],
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSupplierGroups(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supplierGroup.count({ where }),
      this.prisma.supplierGroup.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listPriceBooks(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    include: Set<string>,
  ) {
    const where = this.timestampWhere(
      query,
      query.includeInactive ? {} : { isActive: true },
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.priceBook.count({ where }),
      this.prisma.priceBook.findMany({
        where,
        include: { priceBookDetails: include.has('details') },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listPurchaseOrders(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        include: { items: include.has('details') },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listTransfers(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    include: Set<string>,
  ) {
    // Phiếu chuyển có hai chi nhánh; lọc theo `branchIds` phải khớp cả nơi gửi
    // lẫn nơi nhận, nếu không đối tác sẽ mất một nửa số phiếu liên quan.
    const where = this.timestampWhere(query, {
      ...(branchIds.length
        ? {
            OR: [
              { fromBranchId: { in: branchIds } },
              { toBranchId: { in: branchIds } },
            ],
          }
        : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.transfer.count({ where }),
      this.prisma.transfer.findMany({
        where,
        include: { details: include.has('details') },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listCashFlows(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.cashFlow.count({ where }),
      this.prisma.cashFlow.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSurcharges(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.surcharge.count({ where }),
      this.prisma.surcharge.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listLocations(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    const where = this.timestampWhere(
      query,
      query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { normalName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {},
    );
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.location.count({ where }),
      this.prisma.location.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSettings(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
  ) {
    // Thiết lập cửa hàng chỉ có một bản ghi, nhưng vẫn trả qua envelope danh
    // sách để đối tác dùng chung một kiểu phản hồi cho mọi resource.
    const where = this.timestampWhere(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.settings.count({ where }),
      this.prisma.settings.findMany({
        where,
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listOrderSuppliers(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.orderSupplier.count({ where }),
      this.prisma.orderSupplier.findMany({
        where,
        include: {
          items: include.has('details'),
          payments: include.has('payments'),
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listConsignments(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    customerIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(customerIds.length ? { customerId: { in: customerIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.consignment.count({ where }),
      this.prisma.consignment.findMany({
        where,
        include: {
          items: include.has('details'),
          delivery: include.has('delivery'),
        },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  private async listSupplierReturns(
    query: PublicApiListQueryDto,
    skip: number,
    take: number,
    branchIds: number[],
    include: Set<string>,
  ) {
    const where = this.timestampWhere(query, {
      ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
      ...(query.status
        ? {
            status: {
              in: query.status.split(',').map(Number).filter(Number.isFinite),
            },
          }
        : {}),
    });
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.supplierReturn.count({ where }),
      this.prisma.supplierReturn.findMany({
        where,
        include: { details: include.has('details') },
        orderBy: this.orderBy(query),
        skip,
        take,
      }),
    ]);
    return { total, rows };
  }

  /**
   * Luôn chốt thêm `id` làm khoá phụ: chỉ sắp theo `updatedAt` thì các bản ghi
   * trùng mốc thời gian có thứ tự không xác định, phân trang bằng offset sẽ
   * lặp hoặc bỏ sót bản ghi giữa hai lần gọi.
   */
  private orderBy(query: PublicApiListQueryDto) {
    const direction: 'asc' | 'desc' =
      query.orderDirection === 'desc' ? 'desc' : 'asc';
    const field = query.orderBy || 'updatedAt';
    if (field === 'id') return [{ id: direction }];
    return [{ [field]: direction }, { id: direction }] as any;
  }

  /**
   * Dùng chung phép chiếu công khai cho đường ghi, để dữ liệu trả về sau khi
   * tạo/sửa giống hệt lúc đọc và không rò trường nhạy cảm nào.
   */
  toPublicResource(resource: Resource, row: any): any {
    return this.mapResource(resource, row);
  }

  private mapResource(resource: Resource, row: any): any {
    const base = this.toJson(row);
    switch (resource) {
      case 'customers': {
        const {
          invoiceCccdCmnd,
          invoiceBankAccount,
          identificationNumber,
          misaEmployeeCode,
          misaEmployeeId,
          misaEmployeeName,
          larkRecordId,
          larkSyncRetries,
          larkSyncStatus,
          larkSyncedAt,
          kiotVietId,
          lastSyncedAt,
          createdBy,
          updatedBy,
          ...customer
        } = base;
        if (customer.customerGroupDetails)
          customer.groups = customer.customerGroupDetails.map(
            (item: any) => item.customerGroup,
          );
        delete customer.customerGroupDetails;
        return customer;
      }
      case 'products': {
        const {
          kiotVietId,
          lastSyncedAt,
          misa_code,
          misa_name,
          misa_unit,
          larkRecordId,
          larkSyncRetries,
          larkSyncStatus,
          larkSyncedAt,
          primaryFactoryId,
          backupFactoryId,
          ...product
        } = base;
        return product;
      }
      case 'orders': {
        const {
          kiotVietId,
          lastSyncedAt,
          larkRecordId,
          larkSyncRetries,
          larkSyncStatus,
          larkSyncedAt,
          createdBy,
          soldById,
          ...order
        } = base;
        return order;
      }
      case 'invoices': {
        const {
          kiotVietId,
          lastSyncedAt,
          misaCallbackReceivedAt,
          misaConfirmed,
          misaErrorMessage,
          misaOrgRefId,
          misaSyncRetries,
          misaSyncStatus,
          misaSyncedAt,
          createdBy,
          soldById,
          ...invoice
        } = base;
        return invoice;
      }
      case 'suppliers': {
        const {
          kiotVietId,
          lastSyncedAt,
          createdBy,
          createdName,
          ...supplier
        } = base;
        return supplier;
      }
      case 'purchase-orders': {
        const {
          kiotVietId,
          lastSyncedAt,
          createdBy,
          purchaseById,
          ...purchaseOrder
        } = base;
        return purchaseOrder;
      }
      case 'transfers': {
        const { kiotVietId, lastSyncedAt, createdById, ...transfer } = base;
        return transfer;
      }
      case 'cashflows': {
        const {
          kiotVietId,
          lastSyncedAt,
          createdBy,
          collectorUserId,
          sepayReferenceCode,
          ...cashFlow
        } = base;
        return cashFlow;
      }
      case 'order-suppliers': {
        const {
          kiotVietId,
          lastSyncedAt,
          createdBy,
          userId,
          ...orderSupplier
        } = base;
        return orderSupplier;
      }
      case 'consignments': {
        const { createdBy, soldById, ...consignment } = base;
        return consignment;
      }
      case 'supplier-returns': {
        const {
          createdBy,
          createdByName,
          exportedById,
          exportedByName,
          refundConfirmedBy,
          refundConfirmedByName,
          ...supplierReturn
        } = base;
        return supplierReturn;
      }
      case 'trademarks':
      case 'sale-channels':
      case 'bank-accounts':
      case 'surchages':
      case 'price-books': {
        const { kiotVietId, lastSyncedAt, ...rest } = base;
        return rest;
      }
      default:
        return base;
    }
  }

  private timestampWhere(
    query: PublicApiListQueryDto,
    extra: Record<string, unknown> = {},
    timestampField: 'updatedAt' | 'createdAt' = 'updatedAt',
  ) {
    const and: Prisma.Enumerable<Record<string, unknown>> = [extra];
    if (query.lastModifiedFrom || query.lastModifiedTo) {
      and.push({
        [timestampField]: {
          ...(query.lastModifiedFrom
            ? { gte: new Date(query.lastModifiedFrom) }
            : {}),
          ...(query.lastModifiedTo
            ? { lte: new Date(query.lastModifiedTo) }
            : {}),
        },
      });
    }
    return { AND: and } as any;
  }

  private parseIds(value?: string): number[] {
    return (value || '')
      .split(',')
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  private toJson(value: any): any {
    if (typeof value === 'bigint') return value.toString();
    if (value === null || value === undefined || typeof value !== 'object')
      return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.toJson(item));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.toJson(item)]),
    );
  }
}
