import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerQueryDto,
  BulkCreateCustomerDto,
  BulkUpdateCustomerDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: CustomerQueryDto, userId?: number) {
    const {
      code,
      name,
      contactNumber,
      lastModifiedFrom,
      pageSize = 20,
      currentItem = 0,
      orderBy = 'createdAt',
      orderDirection = 'desc',
      includeRemoveIds = false,
      includeTotal = false,
      includeCustomerGroup = false,
      birthDate,
      groupId,
      includeCustomerSocial = false,
      customerType,
      gender,
      branchId,
      createdBy,
      createdDateFrom,
      createdDateTo,
      birthdayFrom,
      birthdayTo,
      totalPurchasedFrom,
      totalPurchasedTo,
      debtFrom,
      debtTo,
      pointFrom,
      pointTo,
      isActive,
    } = query;

    const where: any = {};

    if (isActive !== undefined) {
      where.isActive = isActive;
    } else {
      where.isActive = true;
    }

    if (code) {
      where.code = { contains: code, mode: 'insensitive' };
    }

    if (name) {
      where.name = { contains: name, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.OR = [
        { contactNumber: { contains: contactNumber } },
        { phone: { contains: contactNumber } },
      ];
    }

    if (lastModifiedFrom) {
      where.updatedAt = { gte: new Date(lastModifiedFrom) };
    }

    if (birthDate) {
      const birthDateObj = new Date(birthDate);
      where.birthDate = {
        gte: new Date(
          birthDateObj.getFullYear(),
          birthDateObj.getMonth(),
          birthDateObj.getDate(),
        ),
        lt: new Date(
          birthDateObj.getFullYear(),
          birthDateObj.getMonth(),
          birthDateObj.getDate() + 1,
        ),
      };
    }

    let isAdmin = false;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          userRoles: {
            include: {
              role: {
                select: { name: true },
              },
            },
          },
        },
      });

      isAdmin =
        user?.userRoles.some(
          (ur) => ur.role.name === 'Admin' || ur.role.name === 'Super Admin',
        ) || false;
    }

    if (userId && !isAdmin) {
      const allowedGroups = await this.prisma.customerGroup.findMany({
        where: {
          OR: [
            { allowedUserIds: { isEmpty: true } },
            { allowedUserIds: { has: userId } },
          ],
        },
        select: { id: true },
      });

      const allowedGroupIds = allowedGroups.map((g) => g.id);

      if (groupId) {
        if (!allowedGroupIds.includes(groupId)) {
          return {
            data: [],
            total: 0,
            pageSize,
            currentItem,
          };
        }
        where.customerGroupDetails = {
          some: { customerGroupId: groupId },
        };
      } else {
        where.customerGroupDetails = {
          some: { customerGroupId: { in: allowedGroupIds } },
        };
      }
    } else if (groupId) {
      where.customerGroupDetails = {
        some: { customerGroupId: groupId },
      };
    }

    if (customerType && customerType !== 'all') {
      where.type = customerType === 'individual' ? 0 : 1;
    }

    if (gender && gender !== 'all') {
      where.gender = gender === 'male' ? true : false;
    }

    if (branchId !== undefined) {
      where.branchId = branchId;
    }

    if (createdBy !== undefined) {
      where.createdBy = createdBy;
    }

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) {
        where.createdAt.gte = new Date(createdDateFrom);
      }
      if (createdDateTo) {
        const endDate = new Date(createdDateTo);
        endDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = endDate;
      }
    }

    if (birthdayFrom || birthdayTo) {
      where.birthDate = {};
      if (birthdayFrom) {
        const startDate = new Date(birthdayFrom);
        where.birthDate.gte = new Date(
          1900,
          startDate.getMonth(),
          startDate.getDate(),
        );
      }
      if (birthdayTo) {
        const endDate = new Date(birthdayTo);
        where.birthDate.lte = new Date(
          2100,
          endDate.getMonth(),
          endDate.getDate(),
        );
      }
    }

    if (totalPurchasedFrom !== undefined || totalPurchasedTo !== undefined) {
      where.totalPurchased = {};
      if (totalPurchasedFrom !== undefined) {
        where.totalPurchased.gte = totalPurchasedFrom;
      }
      if (totalPurchasedTo !== undefined) {
        where.totalPurchased.lte = totalPurchasedTo;
      }
    }

    if (debtFrom !== undefined || debtTo !== undefined) {
      where.totalDebt = {};
      if (debtFrom !== undefined) {
        where.totalDebt.gte = debtFrom;
      }
      if (debtTo !== undefined) {
        where.totalDebt.lte = debtTo;
      }
    }

    if (pointFrom !== undefined || pointTo !== undefined) {
      where.totalPoint = {};
      if (pointFrom !== undefined) {
        where.totalPoint.gte = pointFrom;
      }
      if (pointTo !== undefined) {
        where.totalPoint.lte = pointTo;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip: currentItem,
        take: pageSize,
        include: includeCustomerGroup
          ? {
              customerType: true,
              branch: true,
              customerGroupDetails: {
                include: {
                  customerGroup: { select: { id: true, name: true } },
                },
              },
            }
          : {
              customerType: true,
              branch: true,
            },
        orderBy: { [orderBy]: orderDirection },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      data,
      total,
      pageSize,
      currentItem,
    };
  }

  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        customerType: true,
        branch: true,
        parent: {
          select: { id: true, code: true, name: true },
        },
        children: {
          select: {
            id: true,
            code: true,
            name: true,
            districtName: true,
            wardName: true,
            address: true,
            cityName: true,
          },
        },
        customerGroupDetails: {
          include: {
            customerGroup: { select: { id: true, name: true } },
          },
        },
        orders: {
          select: {
            id: true,
            grandTotal: true,
            debtAmount: true,
          },
        },
        invoices: {
          select: {
            id: true,
            grandTotal: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException(`Customer with id ${id} not found`);
    }

    const groups = customer.customerGroupDetails
      .map((detail) => detail.customerGroup.name)
      .join(', ');

    return {
      ...customer,
      groups,
      debt: customer.totalDebt,
      totalInvoiced: customer.totalInvoiced,
      totalPoint: customer.totalPoint,
      totalRevenue: customer.totalRevenue,
      rewardPoint: customer.rewardPoint,
      customerGroupDetails: customer.customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customerGroup: detail.customerGroup,
      })),
    };
  }

  async findByCode(code: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { code },
      include: {
        customerType: true,
        branch: true,
        customerGroupDetails: {
          include: {
            customerGroup: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException(`Customer with code ${code} not found`);
    }

    const groups = customer.customerGroupDetails
      .map((detail) => detail.customerGroup.name)
      .join(', ');

    return {
      ...customer,
      groups,
      customerGroupDetails: customer.customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customerGroup: detail.customerGroup,
      })),
    };
  }

  async findParents(search?: string) {
    const where: any = {
      parentId: null,
      isActive: true,
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { contactNumber: { contains: search } },
      ];
    }

    const data = await this.prisma.customer.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        phone: true,
        address: true,
        cityName: true,
        districtName: true,
        wardName: true,
        _count: {
          select: { children: true },
        },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return { data };
  }

  async findChildren(parentId: number, search?: string) {
    const where: any = {
      parentId: parentId,
      isActive: true,
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { contactNumber: { contains: search } },
      ];
    }

    const data = await this.prisma.customer.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        phone: true,
        address: true,
        cityName: true,
        districtName: true,
        wardName: true,
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return { data };
  }

  async create(dto: CreateCustomerDto, userId?: number) {
    const code = dto.code || (await this.generateCode());

    if (dto.parentId) {
      const parentCustomer = await this.prisma.customer.findUnique({
        where: { id: dto.parentId },
        select: { id: true, parentId: true },
      });
      if (!parentCustomer) {
        throw new BadRequestException('Tài khoản cha không tồn tại');
      }
      if (parentCustomer.parentId !== null) {
        throw new BadRequestException(
          'Không thể chọn tài khoản con làm tài khoản cha (chỉ hỗ trợ 1 cấp)',
        );
      }
    }

    const { groupIds, birthDate, ...customerData } = dto;

    const customer = await this.prisma.$transaction(async (tx) => {
      const newCustomer = await tx.customer.create({
        data: {
          ...customerData,
          code,
          birthDate: birthDate ? new Date(birthDate) : undefined,
        },
        include: {
          customerType: true,
          branch: true,
        },
      });

      if (groupIds && groupIds.length > 0) {
        const customerGroups = await tx.customerGroup.findMany({
          where: { id: { in: groupIds } },
          select: { id: true, name: true },
        });

        await tx.customerGroupDetail.createMany({
          data: groupIds.map((groupId) => ({
            customerId: newCustomer.id,
            customerGroupId: groupId,
          })),
        });

        const groupsString = customerGroups.map((g) => g.name).join('|');
        await tx.customer.update({
          where: { id: newCustomer.id },
          data: { groups: groupsString },
        });
      }

      return newCustomer;
    });

    const customerGroupDetails = await this.prisma.customerGroupDetail.findMany(
      {
        where: { customerId: customer.id },
        include: {
          customerGroup: { select: { id: true, name: true } },
        },
      },
    );

    const groupsString = customerGroupDetails
      .map((d) => d.customerGroup.name)
      .join(', ');

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'CUSTOMER_CREATE',
        entityType: 'customers',
        entityId: customer.id.toString(),
        entityCode: customer.code || '',
        category: getCategoryFromActionCode('CUSTOMER_CREATE'),
        severity: getSeverityFromActionCode('CUSTOMER_CREATE'),
        snapshot: this.buildCustomerSnapshot(customer, groupsString),
        message: renderAuditMessage('CUSTOMER_CREATE', {
          customerName: customer.name,
          customerCode: customer.code,
          contactNumber: customer.contactNumber || 'N/A',
        }),
        messageTemplate: 'CUSTOMER_CREATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return {
      ...customer,
      customerGroupDetails: customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customerGroup: detail.customerGroup,
      })),
    };
  }

  async update(id: number, dto: UpdateCustomerDto, userId?: number) {
    const { groupIds, birthDate, ...customerData } = dto;

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id },
      include: { customerType: true, branch: true },
    });

    const customer = await this.prisma.$transaction(async (tx) => {
      const updatedCustomer = await tx.customer.update({
        where: { id },
        data: {
          ...customerData,
          birthDate: birthDate ? new Date(birthDate) : undefined,
        },
        include: {
          customerType: true,
          branch: true,
        },
      });

      if (groupIds !== undefined) {
        await tx.customerGroupDetail.deleteMany({
          where: { customerId: id },
        });

        if (groupIds.length > 0) {
          const customerGroups = await tx.customerGroup.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true },
          });

          await tx.customerGroupDetail.createMany({
            data: groupIds.map((groupId) => ({
              customerId: id,
              customerGroupId: groupId,
            })),
          });

          const groupsString = customerGroups.map((g) => g.name).join('|');
          await tx.customer.update({
            where: { id },
            data: { groups: groupsString },
          });
        } else {
          await tx.customer.update({
            where: { id },
            data: { groups: null },
          });
        }
      }

      return updatedCustomer;
    });

    if (dto.parentId !== undefined) {
      if (dto.parentId !== null) {
        if (dto.parentId === id) {
          throw new BadRequestException(
            'Không thể chọn chính mình làm tài khoản cha',
          );
        }

        const hasChildren = await this.prisma.customer.count({
          where: { parentId: id },
        });
        if (hasChildren > 0) {
          throw new BadRequestException(
            'Tài khoản đã có tài khoản con, không thể trở thành tài khoản con',
          );
        }

        const parentCustomer = await this.prisma.customer.findUnique({
          where: { id: dto.parentId },
          select: { id: true, parentId: true },
        });
        if (!parentCustomer) {
          throw new BadRequestException('Tài khoản cha không tồn tại');
        }
        if (parentCustomer.parentId !== null) {
          throw new BadRequestException(
            'Không thể chọn tài khoản con làm tài khoản cha (chỉ hỗ trợ 1 cấp)',
          );
        }
      }
    }

    if (userId && existingCustomer) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      const changes = buildChanges(
        'customers',
        {
          name: existingCustomer.name,
          contactNumber: existingCustomer.contactNumber,
          email: existingCustomer.email,
          address: existingCustomer.address,
          wardName: existingCustomer.wardName,
          taxCode: existingCustomer.taxCode,
          isActive: existingCustomer.isActive,
        },
        {
          name: customer.name,
          contactNumber: customer.contactNumber,
          email: customer.email,
          address: customer.address,
          wardName: customer.wardName,
          taxCode: customer.taxCode,
          isActive: customer.isActive,
        },
      );

      const groupDetails = await this.prisma.customerGroupDetail.findMany({
        where: { customerId: id },
        include: { customerGroup: { select: { name: true } } },
      });
      const groupsString = groupDetails
        .map((d) => d.customerGroup.name)
        .join(', ');

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'CUSTOMER_UPDATE',
        entityType: 'customers',
        entityId: id.toString(),
        entityCode: customer.code || '',
        category: getCategoryFromActionCode('CUSTOMER_UPDATE'),
        severity: getSeverityFromActionCode('CUSTOMER_UPDATE'),
        snapshot: this.buildCustomerSnapshot(customer, groupsString),
        changes: changes.length > 0 ? changes : null,
        message: renderAuditMessage('CUSTOMER_UPDATE', {
          customerName: customer.name,
          customerCode: customer.code,
        }),
        messageTemplate: 'CUSTOMER_UPDATE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    const customerGroupDetails = await this.prisma.customerGroupDetail.findMany(
      {
        where: { customerId: customer.id },
        include: {
          customerGroup: { select: { id: true, name: true } },
        },
      },
    );

    return {
      ...customer,
      customerGroupDetails: customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customerGroup: detail.customerGroup,
      })),
    };
  }

  async remove(id: number, userId?: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: { customerType: true, branch: true },
    });

    await this.prisma.customer.update({
      where: { id },
      data: { isActive: false },
    });

    if (userId && customer) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, branchId: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'CUSTOMER_DELETE',
        entityType: 'customers',
        entityId: id.toString(),
        entityCode: customer.code || '',
        category: getCategoryFromActionCode('CUSTOMER_DELETE'),
        severity: getSeverityFromActionCode('CUSTOMER_DELETE'),
        snapshot: this.buildCustomerSnapshot(customer),
        message: renderAuditMessage('CUSTOMER_DELETE', {
          customerName: customer.name,
          customerCode: customer.code,
        }),
        messageTemplate: 'CUSTOMER_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
        branchId: user?.branchId || undefined,
      });
    }

    return { message: 'Xóa dữ liệu thành công' };
  }

  async bulkCreate(dto: BulkCreateCustomerDto) {
    const results: any[] = [];

    for (const customerDto of dto.listCustomers) {
      try {
        const customer = await this.create(customerDto);
        results.push(customer);
      } catch (error) {
        console.error(`Error creating customer: ${error.message}`);
      }
    }

    return {
      message: 'Thêm mới danh sách khách hàng thành công',
      data: results,
    };
  }

  async bulkUpdate(dto: BulkUpdateCustomerDto) {
    const results: any[] = [];

    for (const customerDto of dto.listCustomers) {
      const { id, ...updateData } = customerDto as any;
      try {
        const customer = await this.update(id, updateData);
        results.push(customer);
      } catch (error) {
        console.error(`Error updating customer ${id}: ${error.message}`);
      }
    }

    return {
      message: 'Cập nhật danh sách khách hàng thành công',
      data: results,
    };
  }

  private async generateCode(): Promise<string> {
    const count = await this.prisma.customer.count();
    return `KH${String(count + 1).padStart(6, '0')}`;
  }

  async getDebtTimeline(customerId: number) {
    const timeline: any[] = [];

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, parentId: true },
    });

    if (!customer) {
      throw new NotFoundException('Không tìm thấy khách hàng');
    }

    const invoiceCustomerIds =
      customer.parentId === null
        ? [customerId]
        : [customerId, customer.parentId];

    const invoices = await this.prisma.invoice.findMany({
      where: {
        customerId: { in: invoiceCustomerIds },
        status: { notIn: [2] },
      },
      select: {
        id: true,
        code: true,
        purchaseDate: true,
        grandTotal: true,
        createdAt: true,
        branchId: true,
        soldById: true,
        customerId: true,
        branch: { select: { id: true, name: true } },
        soldBy: { select: { id: true, name: true } },
        customer: { select: { id: true, code: true, name: true } },
      },
      orderBy: { purchaseDate: 'desc' },
    });

    for (const inv of invoices) {
      timeline.push({
        type: 'invoice',
        id: inv.id,
        code: inv.code,
        date: inv.purchaseDate,
        createdAt: inv.createdAt,
        amount: Number(inv.grandTotal),
        method: null,
        description: 'Bán hàng',
        debtSnapshot: 0,
        status: 1,
        statusValue: 'Hoàn thành',
        branch: inv.branch,
        user: inv.soldBy,
        customerName: inv.customer?.name || null,
        customerCode: inv.customer?.code || null,
      });
    }

    const cashFlowPartnerIds =
      customer.parentId === null
        ? [customerId]
        : [customerId, customer.parentId];

    const cashFlows = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'C',
        partnerId: { in: cashFlowPartnerIds },
        // THÊM: Lấy cả phiếu thu (isReceipt = true) VÀ phiếu chi từ trả hàng (CHI-TH)
        OR: [{ isReceipt: true }, { code: { startsWith: 'CHI-TH' } }],
      },
      select: {
        id: true,
        code: true,
        isReceipt: true,
        amount: true,
        transDate: true,
        method: true,
        description: true,
        createdAt: true,
        branchId: true,
        createdBy: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { transDate: 'desc' },
    });

    for (const cf of cashFlows) {
      timeline.push({
        type: cf.isReceipt ? 'payment' : 'expense', // THÊM: phân biệt payment vs expense
        id: cf.id,
        code: cf.code,
        date: cf.transDate,
        createdAt: cf.createdAt,
        amount: Number(cf.amount),
        method: cf.method,
        description:
          cf.description ||
          (cf.isReceipt ? 'Thu tiền khách hàng' : 'Chi hoàn tiền trả hàng'),
        debtSnapshot: 0,
        status: 0,
        statusValue: cf.isReceipt ? 'Đã thanh toán' : 'Đã chi',
        branch: cf.branch,
        user: cf.creator,
        customerName: null,
        customerCode: null,
      });
    }

    const returnOrderCustomerIds =
      customer.parentId === null
        ? [customerId, ...cashFlowPartnerIds]
        : [customerId];

    // THÊM: Lấy ReturnOrder với refundType = 'cash_refund' để hiển thị trong timeline
    const returnOrdersCashRefund = await this.prisma.returnOrder.findMany({
      where: {
        customerId: { in: returnOrderCustomerIds },
        status: 4,
        refundType: 'cash_refund',
      },
      select: {
        id: true,
        code: true,
        refundAmount: true,
        refundedAmount: true,
        customerDebtSnapshot: true,
        refundConfirmedAt: true,
        createdAt: true,
        branchId: true,
        customerId: true,
        branch: { select: { id: true, name: true } },
        customer: { select: { id: true, code: true, name: true } },
      },
      orderBy: { refundConfirmedAt: 'desc' },
    });

    for (const ro of returnOrdersCashRefund) {
      timeline.push({
        type: 'return_order',
        id: ro.id,
        code: ro.code,
        date: ro.refundConfirmedAt || ro.createdAt,
        createdAt: ro.createdAt,
        amount: Number(ro.refundAmount),
        method: null,
        description: `Trả hàng ${ro.code}`,
        debtSnapshot: 0,
        status: 4,
        statusValue: 'Trả hàng',
        branch: ro.branch,
        user: null,
        customerName: ro.customer?.name || null,
        customerCode: ro.customer?.code || null,
      });
    }

    // ✅ Query DUY NHẤT cho tất cả ReturnOrder
    const allReturnOrders = await this.prisma.returnOrder.findMany({
      where: {
        customerId: { in: returnOrderCustomerIds },
        OR: [
          // TH: Phiếu trả hàng từ step 2 trở lên (KHÔNG lấy step 3 cash_refund vì đã có phiếu chi)
          {
            code: { startsWith: 'TH' },
            status: { in: [2, 3, 4, 5] },
            NOT: {
              AND: [{ status: 4 }, { refundType: 'cash_refund' }],
            },
          },
          // CTN: CHỈ lấy khi đã bị hủy (status = 5)
          {
            refundType: 'manual_offset',
            status: 5, // ✅ CHỈ lấy CTN đã hủy
          },
        ],
      },
      select: {
        id: true,
        code: true,
        status: true,
        refundAmount: true,
        refundType: true,
        customerDebtSnapshot: true,
        confirmedAt: true,
        refundConfirmedAt: true,
        createdAt: true,
        branchId: true,
        customerId: true,
        branch: { select: { id: true, name: true } },
        customer: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // ✅ Push vào timeline
    for (const ro of allReturnOrders) {
      const displayDate =
        ro.refundConfirmedAt || ro.confirmedAt || ro.createdAt;

      let itemType: string;
      let description: string;

      if (ro.status === 5 && ro.refundType === 'manual_offset') {
        // CTN đã hủy
        itemType = 'ctn_cancelled';
        description = `Hủy cấn trừ nợ ${ro.code}`;
      } else if (ro.status === 4 && ro.refundType === 'debt_offset') {
        itemType = 'debt_offset';
        description = `Cấn trừ công nợ từ trả hàng ${ro.code}`;
      } else {
        itemType = 'return_order';
        description = `Trả hàng ${ro.code}`;
      }

      timeline.push({
        type: itemType,
        id: ro.id,
        code: ro.code,
        date: displayDate,
        createdAt: ro.createdAt,
        amount: Number(ro.refundAmount),
        method: null,
        description,
        debtSnapshot: 0,
        status: ro.status,
        statusValue:
          ro.status === 5
            ? 'Đã hủy'
            : ro.status === 4 && ro.refundType === 'debt_offset'
              ? 'Cấn trừ công nợ'
              : 'Trả hàng',
        branch: ro.branch,
        user: null,
        customerName: ro.customer?.name || null,
        customerCode: ro.customer?.code || null,
      });
    }

    // Tính lại debtSnapshot theo zigzag
    timeline.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    let runningDebt = 0;
    for (const item of timeline) {
      if (item.type === 'invoice') {
        runningDebt += item.amount;
      } else if (item.type === 'return_order') {
        runningDebt -= item.amount;
      } else if (item.type === 'expense') {
        runningDebt += item.amount;
      } else if (item.type === 'ctn_cancelled') {
        // ✅ THÊM: Hủy CTN → Cộng lại (hoàn lại dư nợ)
        runningDebt += item.amount;
      } else {
        // payment, debt_offset: trừ đi
        runningDebt -= item.amount;
      }
      item.debtSnapshot = runningDebt;
    }

    // Sắp xếp giảm dần
    const typeOrder: Record<string, number> = {
      payment: 0,
      expense: 1,
      debt_offset: 2,
      return_order: 3,
      invoice: 4,
    };
    timeline.sort((a, b) => {
      const timeDiff =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (typeOrder[a.type] ?? 5) - (typeOrder[b.type] ?? 5);
    });

    return { data: timeline };
  }

  private buildCustomerSnapshot(customer: any, groups?: string) {
    return {
      code: customer.code,
      name: customer.name,
      contactNumber: customer.contactNumber,
      email: customer.email,
      address: customer.address,
      wardName: customer.wardName,
      taxCode: customer.taxCode,
      birthDate: customer.birthDate,
      isActive: customer.isActive,
      groups: groups || customer.groups,
      totalPurchased: customer.totalPurchased
        ? Number(customer.totalPurchased)
        : 0,
      totalDebt: customer.totalDebt ? Number(customer.totalDebt) : 0,
      customerType: customer.customerType
        ? { name: customer.customerType.name }
        : null,
      branch: customer.branch ? { name: customer.branch.name } : null,
    };
  }
}
