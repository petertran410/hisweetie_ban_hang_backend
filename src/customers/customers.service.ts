import {
  BadRequestException,
  ConflictException,
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
  ImportCustomersDto,
} from './dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  renderAuditMessage,
  getCategoryFromActionCode,
  getSeverityFromActionCode,
} from '../audit-logs/audit-templates';
import { buildChanges } from '../audit-logs/audit-diff.utils';
import { ImportBalanceAdjustmentsDto } from './dto/import-balance-adjustment.dto';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async exportCustomers(
    query: CustomerQueryDto,
    userId: number | undefined,
    res: Response,
  ): Promise<void> {
    const {
      code,
      name,
      contactNumber,
      lastModifiedFrom,
      orderBy = 'createdAt',
      orderDirection = 'desc',
      birthDate,
      groupId,
      customerType,
      gender,
      branchId,
      createdBy,
      createdDateFrom,
      createdDateTo,
      birthdayFrom,
      birthdayTo,
      lastTransactionFrom,
      lastTransactionTo,
      totalPurchasedFrom,
      totalPurchasedTo,
      debtFrom,
      debtTo,
      pointFrom,
      pointTo,
      isActive,
    } = query;

    // ── where building (giữ nguyên logic) ────────────────────────────────────
    const where: any = {};

    if (isActive !== undefined) {
      where.isActive = isActive;
    } else {
      where.isActive = true;
    }

    if (code) where.code = { contains: code, mode: 'insensitive' };
    if (name) where.name = { contains: name, mode: 'insensitive' };

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
      const d = new Date(birthDate);
      where.birthDate = {
        gte: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
        lt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
      };
    }

    let isAdmin = false;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          userRoles: { include: { role: { select: { name: true } } } },
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
          res.end(); // không có quyền → trả file rỗng
          return;
        }
        where.customerGroupDetails = { some: { customerGroupId: groupId } };
      } else {
        where.customerGroupDetails = {
          some: { customerGroupId: { in: allowedGroupIds } },
        };
      }
    } else if (groupId) {
      where.customerGroupDetails = { some: { customerGroupId: groupId } };
    }

    if (customerType && customerType !== 'all') {
      where.type = customerType === 'individual' ? 0 : 1;
    }
    if (gender && gender !== 'all') {
      where.gender = gender === 'male' ? true : false;
    }
    if (branchId !== undefined) where.branchId = branchId;
    if (createdBy !== undefined) where.createdBy = createdBy;

    if (createdDateFrom || createdDateTo) {
      where.createdAt = {};
      if (createdDateFrom) where.createdAt.gte = new Date(createdDateFrom);
      if (createdDateTo) {
        const d = new Date(createdDateTo);
        d.setHours(23, 59, 59, 999);
        where.createdAt.lte = d;
      }
    }

    if (lastTransactionFrom || lastTransactionTo) {
      const invoiceWhere: any = {};
      if (lastTransactionFrom) invoiceWhere.gte = new Date(lastTransactionFrom);
      if (lastTransactionTo) {
        const d = new Date(lastTransactionTo);
        d.setHours(23, 59, 59, 999);
        invoiceWhere.lte = d;
      }
      where.invoices = { some: { purchaseDate: invoiceWhere } };
    }

    if (birthdayFrom || birthdayTo) {
      where.birthDate = {};
      if (birthdayFrom) {
        const d = new Date(birthdayFrom);
        where.birthDate.gte = new Date(1900, d.getMonth(), d.getDate());
      }
      if (birthdayTo) {
        const d = new Date(birthdayTo);
        where.birthDate.lte = new Date(2100, d.getMonth(), d.getDate());
      }
    }

    if (totalPurchasedFrom !== undefined || totalPurchasedTo !== undefined) {
      where.totalPurchased = {};
      if (totalPurchasedFrom !== undefined)
        where.totalPurchased.gte = totalPurchasedFrom;
      if (totalPurchasedTo !== undefined)
        where.totalPurchased.lte = totalPurchasedTo;
    }
    if (debtFrom !== undefined || debtTo !== undefined) {
      where.totalDebt = {};
      if (debtFrom !== undefined) where.totalDebt.gte = debtFrom;
      if (debtTo !== undefined) where.totalDebt.lte = debtTo;
    }
    if (pointFrom !== undefined || pointTo !== undefined) {
      where.totalPoint = {};
      if (pointFrom !== undefined) where.totalPoint.gte = pointFrom;
      if (pointTo !== undefined) where.totalPoint.lte = pointTo;
    }
    // ── kết thúc where building ──────────────────────────────────────────────

    const customerCount = await this.prisma.customer.count({ where });

    if (customerCount === 0) {
      res.end();
      return;
    }

    const now = new Date();

    // groupBy dùng relation filter → Prisma sinh subquery, không dùng IN list bind vars
    const [lastTxRows, debtStartRows] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['customerId'],
        where: {
          customer: where,
          status: { not: 2 },
        },
        _max: { purchaseDate: true },
      }),
      this.prisma.invoice.groupBy({
        by: ['customerId'],
        where: {
          customer: where,
          debtAmount: { gt: 0 },
          status: { not: 2 },
        },
        _min: { purchaseDate: true },
      }),
    ]);

    const lastTxMap = new Map(
      lastTxRows.map((r) => [r.customerId, r._max.purchaseDate]),
    );
    const debtStartMap = new Map(
      debtStartRows.map((r) => [r.customerId, r._min.purchaseDate]),
    );

    // ── Stream Excel ─────────────────────────────────────────────────────────
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Khách hàng');

    sheet.columns = [
      { header: 'Mã khách hàng', key: 'code', width: 18 },
      { header: 'Tên khách hàng', key: 'name', width: 28 },
      { header: 'Điện thoại', key: 'contactNumber', width: 16 },
      { header: 'Điện thoại 2', key: 'phone', width: 16 },
      { header: 'Email', key: 'email', width: 24 },
      { header: 'Ngày sinh', key: 'birthDate', width: 14 },
      { header: 'Giới tính', key: 'gender', width: 10 },
      { header: 'Loại khách hàng', key: 'customerType', width: 16 },
      { header: 'Trạng thái', key: 'isActive', width: 18 },
      { header: 'Số CMND/CCCD', key: 'invoiceCccdCmnd', width: 18 },
      { header: 'Công ty', key: 'organization', width: 24 },
      { header: 'Mã số thuế', key: 'taxCode', width: 16 },
      { header: 'Nhóm khách hàng', key: 'groups', width: 22 },
      { header: 'Ghi chú', key: 'comments', width: 24 },
      { header: 'Địa chỉ', key: 'address', width: 30 },
      { header: 'Khu vực', key: 'locationName', width: 18 },
      { header: 'Phường/Xã', key: 'wardName', width: 18 },
      { header: 'Thành phố', key: 'cityName', width: 18 },
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Nợ cần thu', key: 'totalDebt', width: 16 },
      { header: 'Tổng bán', key: 'totalPurchased', width: 16 },
      { header: 'Tổng bán trừ trả hàng', key: 'totalRevenue', width: 22 },
      { header: 'Ngày giao dịch cuối', key: 'lastTransactionDate', width: 20 },
      { header: 'Số ngày nợ', key: 'debtDays', width: 14 },
      { header: 'Ngày tạo', key: 'createdAt', width: 14 },
      { header: 'Người tạo', key: 'createdByName', width: 20 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    // ── Pass 2: Stream theo batch — không load toàn bộ vào RAM ───────────────
    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.customer.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { [orderBy]: orderDirection },
        include: {
          branch: { select: { id: true, name: true } },
          addresses: { where: { isDefault: true }, take: 1 },
          customerGroupDetails: {
            include: { customerGroup: { select: { id: true, name: true } } },
          },
          creator: { select: { id: true, name: true } },
        },
      });

      if (batch.length === 0) break;

      for (const c of batch) {
        const addr = c.addresses?.[0];
        const groups =
          c.customerGroupDetails?.map((d) => d.customerGroup.name).join('|') ??
          '';

        const lastTxDate = lastTxMap.get(c.id) ?? null;
        const debtStartDate = debtStartMap.get(c.id) ?? null;
        const debtDays = debtStartDate
          ? Math.floor(
              (now.getTime() - new Date(debtStartDate).getTime()) / 86_400_000,
            )
          : 0;

        const row = sheet.addRow({
          code: c.code ?? '',
          name: c.name,
          contactNumber: c.contactNumber ?? '',
          phone: c.phone ?? '',
          email: c.email ?? '',
          birthDate: c.birthDate
            ? new Date(c.birthDate).toLocaleDateString('vi-VN')
            : '',
          gender: c.gender === true ? 'Nam' : c.gender === false ? 'Nữ' : '',
          customerType: c.type === 0 ? 'Cá nhân' : 'Công ty',
          isActive: c.isActive ? 'Đang hoạt động' : 'Ngừng hoạt động',
          invoiceCccdCmnd: c.invoiceCccdCmnd ?? '',
          organization: c.organization ?? '',
          taxCode: c.taxCode ?? '',
          groups,
          comments: c.comments ?? '',
          address: addr?.address ?? '',
          locationName: addr?.locationName ?? '',
          wardName: addr?.wardName ?? (addr as any)?.newWardName ?? '',
          cityName: addr?.cityName ?? (addr as any)?.newCityName ?? '',
          branchName: c.branch?.name ?? '',
          totalDebt: Number(c.totalDebt),
          totalPurchased: Number(c.totalPurchased),
          totalRevenue: Number(c.totalRevenue),
          lastTransactionDate: lastTxDate
            ? new Date(lastTxDate).toLocaleDateString('vi-VN')
            : '',
          debtDays,
          createdAt: new Date(c.createdAt).toLocaleDateString('vi-VN'),
          createdByName: c.creator?.name ?? '',
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

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
      lastTransactionFrom,
      lastTransactionTo,
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

    if (lastTransactionFrom || lastTransactionTo) {
      const invoiceWhere: any = {};
      if (lastTransactionFrom) {
        invoiceWhere.gte = new Date(lastTransactionFrom);
      }
      if (lastTransactionTo) {
        const endDate = new Date(lastTransactionTo);
        endDate.setHours(23, 59, 59, 999);
        invoiceWhere.lte = endDate;
      }
      where.invoices = {
        some: { purchaseDate: invoiceWhere },
      };
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
        include: {
          customerType: true,
          branch: true,
          addresses: {
            where: { isDefault: true },
            take: 1,
          },
          ...(includeCustomerGroup
            ? {
                customerGroupDetails: {
                  include: {
                    customerGroup: { select: { id: true, name: true } },
                  },
                },
              }
            : {}),
        },
        orderBy: { [orderBy]: orderDirection },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, total, pageSize, currentItem };
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
            contactNumber: true,
            totalDebt: true,
            isActive: true,
          },
          orderBy: { code: 'asc' },
        },
        addresses: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
        customerGroupDetails: {
          include: {
            customerGroup: { select: { id: true, name: true } },
          },
        },
        orders: {
          select: { id: true, grandTotal: true, debtAmount: true },
        },
        invoices: {
          select: { id: true, grandTotal: true },
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
        addresses: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
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

  async searchCustomers(search?: string) {
    const where: any = { isActive: true };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { contactNumber: { contains: search } },
        { phone: { contains: search } },
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
        email: true,
        totalDebt: true,
        parentId: true,
        parent: {
          select: { code: true, name: true },
        },
        addresses: {
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
          },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return { data };
  }

  async create(dto: CreateCustomerDto, userId?: number) {
    await this.checkPhoneDuplicate(dto.contactNumber, dto.phone);

    let code: string;
    if (dto.code) {
      code = dto.code;
    } else if (dto.parentId) {
      code = await this.generateChildCode(dto.parentId);
    } else {
      code = await this.generateCode();
    }

    if (dto.parentId) {
      const parentCustomer = await this.prisma.customer.findUnique({
        where: { id: dto.parentId },
        select: { id: true, parentId: true },
      });
      if (!parentCustomer) {
        throw new BadRequestException('Khách hàng cha không tồn tại');
      }
      if (parentCustomer.parentId) {
        throw new BadRequestException('Không hỗ trợ tạo khách hàng quá 1 cấp');
      }
    }

    const { groupIds, birthDate, addresses, ...customerData } = dto;

    const normalizedAddresses = this.normalizeAddresses(addresses);

    const customer = await this.prisma.$transaction(async (tx) => {
      const newCustomer = await tx.customer.create({
        data: {
          ...customerData,
          code,
          birthDate: birthDate ? new Date(birthDate) : undefined,
          addresses: {
            create: normalizedAddresses.map(({ id: _, ...a }) => a),
          },
        },
        include: {
          customerType: true,
          branch: true,
          addresses: true,
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
    await this.checkPhoneDuplicate(dto.contactNumber, dto.phone, id);

    const { groupIds, birthDate, addresses, ...customerData } = dto;

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id },
      include: { customerType: true, branch: true },
    });

    if (!existingCustomer) {
      throw new NotFoundException(`Customer with id ${id} not found`);
    }

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

      if (addresses !== undefined) {
        if (addresses.length === 0) {
          throw new BadRequestException(
            'Khách hàng phải có ít nhất 1 địa chỉ giao hàng',
          );
        }

        const normalized = this.normalizeAddresses(addresses);

        const existingAddresses = await tx.customerAddress.findMany({
          where: { customerId: id },
          select: { id: true },
        });
        const existingIds = new Set(existingAddresses.map((a) => a.id));
        const incomingIds = new Set(
          normalized.filter((a) => a.id).map((a) => a.id as number),
        );

        const toDelete = [...existingIds].filter(
          (eid) => !incomingIds.has(eid),
        );
        if (toDelete.length > 0) {
          await tx.customerAddress.deleteMany({
            where: { id: { in: toDelete } },
          });
        }

        for (const addr of normalized) {
          const { id: addrId, ...addrData } = addr;
          if (addrId && existingIds.has(addrId)) {
            await tx.customerAddress.update({
              where: { id: addrId },
              data: addrData,
            });
          } else {
            await tx.customerAddress.create({
              data: { ...addrData, customerId: id },
            });
          }
        }
      }

      return updatedCustomer;
    });

    if (userId) {
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
          taxCode: existingCustomer.taxCode,
          isActive: existingCustomer.isActive,
        },
        {
          name: customer.name,
          contactNumber: customer.contactNumber,
          email: customer.email,
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

  async getDebtTimeline(customerId: number, includeChildren = false) {
    const timeline: any[] = [];

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, totalDebt: true },
    });

    if (!customer) {
      throw new NotFoundException('Không tìm thấy khách hàng');
    }

    let allCustomerIds = [customerId];
    if (includeChildren) {
      const children = await this.prisma.customer.findMany({
        where: { parentId: customerId },
        select: { id: true },
      });
      allCustomerIds = [customerId, ...children.map((c) => c.id)];
    }

    const invoiceCustomerIds = allCustomerIds;

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

    const cashFlowPartnerIds = allCustomerIds;

    const cashFlows = await this.prisma.cashFlow.findMany({
      where: {
        partnerType: 'C',
        partnerId: { in: cashFlowPartnerIds },
        status: { not: 2 },
        NOT: [{ code: { startsWith: 'TTTUHD' } }],
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
        partnerId: true,
        partnerName: true,
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { transDate: 'desc' },
    });

    const partnerIds = [
      ...new Set(cashFlows.map((cf) => cf.partnerId).filter(Boolean)),
    ] as number[];
    const partnerCustomers =
      partnerIds.length > 0
        ? await this.prisma.customer.findMany({
            where: { id: { in: partnerIds } },
            select: { id: true, code: true },
          })
        : [];
    const partnerCodeMap = new Map(partnerCustomers.map((c) => [c.id, c.code]));

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
        customerName: cf.partnerName || null,
        customerCode: cf.partnerId
          ? partnerCodeMap.get(cf.partnerId) || null
          : null,
      });
    }

    const returnOrderCustomerIds = allCustomerIds;

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
      // where: {
      //   customerId: { in: returnOrderCustomerIds },
      //   code: { startsWith: 'TH' },
      //   status: { in: [1, 2, 3, 4, 5] },
      //   NOT: {
      //     AND: [{ status: 4 }, { refundType: 'cash_refund' }],
      //   },
      // },
      where: {
        customerId: { in: returnOrderCustomerIds },
        code: { startsWith: 'TH' },
        status: { in: [1, 2, 3, 4] },
        NOT: { AND: [{ status: 4 }, { refundType: 'cash_refund' }] },
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

    for (const ro of allReturnOrders) {
      const displayDate =
        ro.refundConfirmedAt || ro.confirmedAt || ro.createdAt;

      timeline.push({
        type: 'return_order',
        id: ro.id,
        code: ro.code,
        date: displayDate,
        createdAt: ro.createdAt,
        amount: Number(ro.refundAmount),
        method: null,
        description: `Trả hàng ${ro.code}`,
        debtSnapshot: 0,
        status: ro.status,
        statusValue: 'Trả hàng',
        branch: ro.branch,
        user: null,
        customerName: ro.customer?.name || null,
        customerCode: ro.customer?.code || null,
      });
    }

    // Tính lại debtSnapshot theo zigzag
    const calcOrder: Record<string, number> = {
      invoice: 0,
      expense: 1,
      return_order: 2,
      payment: 3,
    };

    timeline.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (calcOrder[a.type] ?? 3) - (calcOrder[b.type] ?? 3);
    });

    let runningDebt = 0;
    for (const item of timeline) {
      if (item.type === 'invoice') {
        runningDebt += item.amount;
      } else if (item.type === 'return_order') {
        runningDebt -= item.amount;
      } else if (item.type === 'expense') {
        runningDebt += item.amount;
      } else {
        // payment: trừ đi
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
      const timeDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
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

  private normalizeAddresses(addresses: any[]) {
    if (!addresses || addresses.length === 0) return [];

    let lastDefaultIdx = -1;
    addresses.forEach((a, i) => {
      if (a.isDefault === true) lastDefaultIdx = i;
    });

    if (lastDefaultIdx === -1) lastDefaultIdx = 0;

    return addresses.map((a, i) => ({
      ...a,
      isDefault: i === lastDefaultIdx,
    }));
  }

  async importCustomers(dto: ImportCustomersDto, userId?: number) {
    const { rows, updateDebt = false } = dto;

    const results = {
      created: 0,
      updated: 0,
      errors: [] as { row: number; name: string; message: string }[],
    };

    // 1. Pre-load tất cả customer groups để map tên → id
    const allGroups = await this.prisma.customerGroup.findMany({
      select: { id: true, name: true },
    });
    const groupNameMap = new Map(
      allGroups.map((g) => [g.name.trim().toLowerCase(), g.id]),
    );

    // 1b. Pre-load tất cả branches để map tên → id       ← THÊM BLOCK NÀY
    const allBranches = await this.prisma.branch.findMany({
      select: { id: true, name: true },
    });
    const branchNameMap = new Map(
      allBranches.map((b) => [b.name.trim().toLowerCase(), b.id]),
    );

    // 2. Pre-load tất cả existing codes để batch lookup
    const incomingCodes = rows
      .map((r) => r.code?.trim())
      .filter((c): c is string => !!c);

    const existingCustomers =
      incomingCodes.length > 0
        ? await this.prisma.customer.findMany({
            where: { code: { in: incomingCodes } },
            select: { id: true, code: true },
          })
        : [];

    const existingCodeMap = new Map(
      existingCustomers.map((c) => [c.code!, c.id]),
    );

    // 3. Lấy user info cho audit log
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true, branchId: true },
        })
      : null;

    // 4. Xử lý từng row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 2; // +2 vì Excel row 1 = header, data bắt đầu từ row 2

      try {
        // Validate name bắt buộc
        if (!row.name?.trim()) {
          results.errors.push({
            row: rowIndex,
            name: '',
            message: 'Tên khách hàng không được để trống',
          });
          continue;
        }

        // Validate contactNumber bắt buộc              ← THÊM ĐOẠN NÀY
        if (!row.contactNumber?.trim()) {
          results.errors.push({
            row: rowIndex,
            name: row.name.trim(),
            message: 'Số điện thoại không được để trống',
          });
          continue;
        }

        // Parse gender
        const gender =
          row.gender?.trim().toLowerCase() === 'nam'
            ? true
            : row.gender?.trim().toLowerCase() === 'nữ'
              ? false
              : undefined;

        // Parse birthDate
        let birthDate: Date | undefined;
        if (row.birthDate?.trim()) {
          const parsed = this.parseImportDate(row.birthDate.trim());
          if (parsed) birthDate = parsed;
        }

        // Parse createdAt                               ← THÊM
        let createdAt: Date | undefined;
        if (row.createdAt?.trim()) {
          const parsed = this.parseImportDateTime(row.createdAt.trim());
          if (parsed) createdAt = parsed;
        }

        // Parse group names → groupIds (tạo mới nếu chưa tồn tại)
        const groupIds: number[] = [];
        if (row.groups?.trim()) {
          const groupNames = row.groups.split('|').map((g) => g.trim());
          for (const gName of groupNames) {
            if (!gName) continue;
            let gId = groupNameMap.get(gName.toLowerCase());
            if (!gId) {
              const newGroup = await this.prisma.customerGroup.create({
                data: { name: gName, createdBy: userId || undefined },
              });
              gId = newGroup.id;
              groupNameMap.set(gName.toLowerCase(), gId);
            }
            groupIds.push(gId);
          }
        }

        // Parse branch name → branchId                    ← THÊM ĐOẠN NÀY
        let branchId: number | undefined;
        if (row.branchName?.trim()) {
          branchId = branchNameMap.get(row.branchName.trim().toLowerCase());
        }

        // Parse totalDebt
        const debtValue =
          updateDebt && row.totalDebt != null
            ? Number(row.totalDebt)
            : undefined;

        const totalPurchasedValue =
          updateDebt && row.totalPurchased != null
            ? Number(row.totalPurchased)
            : undefined;
        const totalRevenueValue =
          updateDebt && row.totalRevenue != null
            ? Number(row.totalRevenue)
            : undefined;

        const code = row.code?.trim() || undefined;
        const existingId = code ? existingCodeMap.get(code) : undefined;

        if (existingId) {
          // ── UPDATE ──
          await this.importUpdateCustomer(
            existingId,
            row,
            gender,
            birthDate,
            groupIds,
            debtValue,
            totalPurchasedValue,
            totalRevenueValue,
            branchId,
          );
          results.updated++;

          if (userId && user) {
            await this.auditLogsService.create({
              actionType: 'PUT',
              actionCode: 'CUSTOMER_UPDATE',
              entityType: 'customers',
              entityId: existingId.toString(),
              entityCode: code || '',
              category: getCategoryFromActionCode('CUSTOMER_UPDATE'),
              severity: getSeverityFromActionCode('CUSTOMER_UPDATE'),
              snapshot: { importRow: rowIndex },
              message: renderAuditMessage('CUSTOMER_UPDATE', {
                customerName: row.name.trim(),
                customerCode: code,
              }),
              messageTemplate: 'CUSTOMER_UPDATE',
              userId,
              userName: user.name || user.email || 'System',
              branchId: user.branchId || undefined,
            });
          }
        } else {
          // ── CREATE ──
          const newCode = code || (await this.generateCode());
          const newCustomer = await this.importCreateCustomer(
            newCode,
            row,
            gender,
            birthDate,
            groupIds,
            debtValue,
            totalPurchasedValue,
            totalRevenueValue,
            branchId,
            createdAt,
          );
          results.created++;

          // Cập nhật map để tránh trùng code trong cùng batch
          if (newCustomer.code) {
            existingCodeMap.set(newCustomer.code, newCustomer.id);
          }

          if (userId && user) {
            await this.auditLogsService.create({
              actionType: 'POST',
              actionCode: 'CUSTOMER_CREATE',
              entityType: 'customers',
              entityId: newCustomer.id.toString(),
              entityCode: newCustomer.code || '',
              category: getCategoryFromActionCode('CUSTOMER_CREATE'),
              severity: getSeverityFromActionCode('CUSTOMER_CREATE'),
              snapshot: { importRow: rowIndex },
              message: renderAuditMessage('CUSTOMER_CREATE', {
                customerName: row.name.trim(),
                customerCode: newCustomer.code,
                contactNumber: row.contactNumber || 'N/A',
              }),
              messageTemplate: 'CUSTOMER_CREATE',
              userId,
              userName: user.name || user.email || 'System',
              branchId: user.branchId || undefined,
            });
          }
        }
      } catch (error) {
        results.errors.push({
          row: rowIndex,
          name: row.name || '',
          message: error.message || 'Lỗi không xác định',
        });
      }
    }

    return {
      message: `Import hoàn tất: ${results.created} tạo mới, ${results.updated} cập nhật, ${results.errors.length} lỗi`,
      ...results,
    };
  }

  // ── Private helpers cho import ──

  private async importCreateCustomer(
    code: string,
    row: any,
    gender: boolean | undefined,
    birthDate: Date | undefined,
    groupIds: number[],
    debtValue: number | undefined,
    totalPurchasedValue: number | undefined,
    totalRevenueValue: number | undefined,
    branchId?: number,
    createdAt?: Date,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          code,
          name: row.name.trim(),
          contactNumber: row.contactNumber?.trim() || undefined,
          phone: row.phone?.trim() || undefined,
          email: row.email?.trim() || undefined,
          gender,
          birthDate,
          organization: row.organization?.trim() || undefined,
          taxCode: row.taxCode?.trim() || undefined,
          comments: row.comments?.trim() || undefined,
          type: row.organization?.trim() ? 1 : 0,
          branchId: branchId || undefined,
          invoiceCccdCmnd: row.cccd?.trim() || undefined,
          ...(debtValue !== undefined ? { totalDebt: debtValue } : {}),
          ...(totalPurchasedValue !== undefined
            ? { totalPurchased: totalPurchasedValue }
            : {}),
          ...(totalRevenueValue !== undefined
            ? { totalRevenue: totalRevenueValue }
            : {}),
          ...(createdAt ? { createdAt } : {}),
          addresses: {
            create: [
              {
                address: row.address?.trim() || undefined,
                locationName: row.locationName?.trim() || undefined,
                wardName: row.wardName?.trim() || undefined,
                receiver: row.name.trim(),
                contactNumber: row.contactNumber?.trim() || undefined,
                isDefault: true,
              },
            ],
          },
        },
      });

      if (groupIds.length > 0) {
        await tx.customerGroupDetail.createMany({
          data: groupIds.map((gId) => ({
            customerId: customer.id,
            customerGroupId: gId,
          })),
        });

        const groups = await tx.customerGroup.findMany({
          where: { id: { in: groupIds } },
          select: { name: true },
        });

        await tx.customer.update({
          where: { id: customer.id },
          data: { groups: groups.map((g) => g.name).join('|') },
        });
      }

      return customer;
    });
  }

  private async importUpdateCustomer(
    id: number,
    row: any,
    gender: boolean | undefined,
    birthDate: Date | undefined,
    groupIds: number[],
    debtValue: number | undefined,
    totalPurchasedValue: number | undefined,
    totalRevenueValue: number | undefined,
    branchId?: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Build update data — chỉ update field có giá trị, không ghi đè field cũ bằng null
      const updateData: any = {};
      if (row.name?.trim()) updateData.name = row.name.trim();
      if (row.contactNumber?.trim())
        updateData.contactNumber = row.contactNumber.trim();
      if (row.phone?.trim()) updateData.phone = row.phone.trim();
      if (row.email?.trim()) updateData.email = row.email.trim();
      if (gender !== undefined) updateData.gender = gender;
      if (birthDate) updateData.birthDate = birthDate;
      if (row.organization?.trim())
        updateData.organization = row.organization.trim();
      if (row.taxCode?.trim()) updateData.taxCode = row.taxCode.trim();
      if (row.comments?.trim()) updateData.comments = row.comments.trim();
      if (debtValue !== undefined) updateData.totalDebt = debtValue;
      if (totalPurchasedValue !== undefined)
        updateData.totalPurchased = totalPurchasedValue;
      if (totalRevenueValue !== undefined)
        updateData.totalRevenue = totalRevenueValue;
      if (branchId) updateData.branchId = branchId;
      if (row.cccd?.trim()) updateData.invoiceCccdCmnd = row.cccd.trim();

      await tx.customer.update({
        where: { id },
        data: updateData,
      });

      // Update address — chỉ cập nhật địa chỉ default nếu có data mới
      const hasAddressData =
        row.address?.trim() || row.locationName?.trim() || row.wardName?.trim();
      if (hasAddressData) {
        const defaultAddr = await tx.customerAddress.findFirst({
          where: { customerId: id, isDefault: true },
        });

        const addrData: any = {};
        if (row.address?.trim()) addrData.address = row.address.trim();
        if (row.locationName?.trim())
          addrData.locationName = row.locationName.trim();
        if (row.wardName?.trim()) addrData.wardName = row.wardName.trim();
        if (row.contactNumber?.trim())
          addrData.contactNumber = row.contactNumber.trim();

        if (defaultAddr) {
          await tx.customerAddress.update({
            where: { id: defaultAddr.id },
            data: addrData,
          });
        } else {
          await tx.customerAddress.create({
            data: {
              customerId: id,
              ...addrData,
              receiver: row.name?.trim(),
              isDefault: true,
            },
          });
        }
      }

      // Update groups — replace toàn bộ nếu có data nhóm
      if (groupIds.length > 0) {
        await tx.customerGroupDetail.deleteMany({
          where: { customerId: id },
        });

        await tx.customerGroupDetail.createMany({
          data: groupIds.map((gId) => ({
            customerId: id,
            customerGroupId: gId,
          })),
        });

        const groups = await tx.customerGroup.findMany({
          where: { id: { in: groupIds } },
          select: { name: true },
        });

        await tx.customer.update({
          where: { id },
          data: { groups: groups.map((g) => g.name).join('|') },
        });
      }
    });
  }

  private parseImportDate(value: string): Date | null {
    // Hỗ trợ: dd/MM/yyyy, dd-MM-yyyy, yyyy-MM-dd
    const ddmmyyyy = value.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    if (ddmmyyyy) {
      const [, d, m, y] = ddmmyyyy;
      const date = new Date(+y, +m - 1, +d);
      if (!isNaN(date.getTime())) return date;
    }

    const iso = value.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
    if (iso) {
      const [, y, m, d] = iso;
      const date = new Date(+y, +m - 1, +d);
      if (!isNaN(date.getTime())) return date;
    }

    // Fallback: Excel serial number (nếu xlsx parse ra number dạng string)
    const num = Number(value);
    if (!isNaN(num) && num > 30000 && num < 60000) {
      const date = new Date((num - 25569) * 86400000);
      if (!isNaN(date.getTime())) return date;
    }

    return null;
  }

  private parseImportDateTime(value: string): Date | null {
    // Format: "23/4/2026 11:53:56" hoặc "23/04/2026 11:53:56"
    const match = value.match(
      /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/,
    );
    if (match) {
      const [, d, m, y, hh, mm, ss] = match;
      const date = new Date(+y, +m - 1, +d, +hh, +mm, +ss);
      if (!isNaN(date.getTime())) return date;
    }

    // Fallback: chỉ có ngày, không có giờ → dùng parseImportDate
    return this.parseImportDate(value);
  }

  private async generateChildCode(parentId: number): Promise<string> {
    const parent = await this.prisma.customer.findUnique({
      where: { id: parentId },
      select: { code: true },
    });

    if (!parent?.code) {
      throw new BadRequestException('Khách hàng cha không có mã');
    }

    // Tìm code con lớn nhất hiện tại: KH000001.1, KH000001.2...
    const existingChildren = await this.prisma.customer.findMany({
      where: { parentId },
      select: { code: true },
      orderBy: { code: 'desc' },
    });

    let nextSeq = 1;
    for (const child of existingChildren) {
      if (!child.code) continue;
      const match = child.code.match(/\.(\d+)$/);
      if (match) {
        nextSeq = Math.max(nextSeq, parseInt(match[1]) + 1);
      }
    }

    return `${parent.code}.${nextSeq}`;
  }

  async importBalanceAdjustments(dto: ImportBalanceAdjustmentsDto) {
    const results = {
      created: 0,
      skipped: 0,
      errors: [] as { row: number; code: string; message: string }[],
    };

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      try {
        // 1. Tìm customer bằng contactNumber
        const customer = await this.prisma.customer.findFirst({
          where: {
            OR: [
              { contactNumber: row.contactNumber },
              { phone: row.contactNumber },
            ],
          },
          select: { id: true, name: true, contactNumber: true },
        });

        if (!customer) {
          results.errors.push({
            row: i + 1,
            code: row.code,
            message: `Không tìm thấy khách hàng với SĐT ${row.contactNumber}`,
          });
          continue;
        }

        // 2. Parse transDate trước để dùng chung cho cả create lẫn update
        const isReceipt = row.amount < 0;
        const absAmount = Math.abs(row.amount);

        let transDate = new Date();
        if (row.transDate) {
          const match = row.transDate.match(
            /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
          );
          if (match) {
            const [, d, m, y, hh = '0', mm = '0', ss = '0'] = match;
            const parsed = new Date(+y, +m - 1, +d, +hh, +mm, +ss);
            if (!isNaN(parsed.getTime())) transDate = parsed;
          } else {
            const parsed = new Date(row.transDate);
            if (!isNaN(parsed.getTime())) transDate = parsed;
          }
        }

        // 3. Upsert CashFlow theo code
        await this.prisma.cashFlow.upsert({
          where: { code: row.code },
          update: {
            isReceipt,
            amount: absAmount,
            transDate,
            partnerId: customer.id,
            partnerName: customer.name,
            contactNumber: customer.contactNumber,
          },
          create: {
            code: row.code,
            branchId: 1,
            isReceipt,
            amount: absAmount,
            transDate,
            method: null,
            partnerType: 'C',
            partnerId: customer.id,
            partnerName: customer.name,
            contactNumber: customer.contactNumber,
            description: `Cân bằng nợ ${row.code}`,
            status: 0,
            statusValue: isReceipt ? 'Đã thanh toán' : 'Đã chi',
            createdBy: 1,
            usedForFinancialReporting: 1,
            customerDebtSnapshot: 0,
          },
        });

        results.created++;
      } catch (error: any) {
        results.errors.push({
          row: i + 1,
          code: row.code,
          message: error.message,
        });
      }
    }

    return {
      message: `Import ${results.created} phiếu cân bằng nợ, bỏ qua ${results.skipped} trùng`,
      ...results,
    };
  }

  private async checkPhoneDuplicate(
    contactNumber?: string,
    phone?: string,
    excludeId?: number,
  ): Promise<void> {
    const numbers = [contactNumber, phone].filter(Boolean) as string[];
    if (numbers.length === 0) return;

    const where: any = {
      OR: numbers.flatMap((num) => [{ contactNumber: num }, { phone: num }]),
    };

    if (excludeId) {
      where.id = { not: excludeId };
    }

    const existing = await this.prisma.customer.findFirst({
      where,
      select: { id: true, name: true, contactNumber: true, phone: true },
    });

    if (!existing) return;

    const matched =
      numbers.find(
        (num) => num === existing.contactNumber || num === existing.phone,
      ) || '';

    throw new ConflictException(
      `Số điện thoại "${matched}" đã được sử dụng bởi khách hàng "${existing.name}"`,
    );
  }

  // ── Export lịch sử giao dịch (debt timeline) ────────────────────────────────
  async exportDebtTimeline(
    customerId: number,
    includeChildren: boolean,
    res: Response,
  ): Promise<void> {
    const { data: timeline } = await this.getDebtTimeline(
      customerId,
      includeChildren,
    );

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDate = (d: any) => {
      if (!d) return '';
      const dt = new Date(d);
      return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    };

    const TYPE_LABEL: Record<string, string> = {
      invoice: 'Hóa đơn',
      payment: 'Thu tiền',
      expense: 'Hoàn tiền',
      return_order: 'Trả hàng',
      debt_offset: 'Cấn trừ nợ',
    };

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Lịch sử thanh toán');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã giao dịch', key: 'code', width: 18 },
      { header: 'Thời gian', key: 'date', width: 20 },
      { header: 'Loại giao dịch', key: 'type', width: 18 },
      { header: 'Mã khách hàng', key: 'customerCode', width: 14 },
      { header: 'Khách hàng', key: 'customerName', width: 24 },
      { header: 'Chi nhánh', key: 'branch', width: 20 },
      { header: 'Người thực hiện', key: 'user', width: 18 },
      { header: 'Giá trị', key: 'amount', width: 16 },
      { header: 'Dư nợ khách hàng', key: 'debtSnapshot', width: 18 },
      { header: 'Trạng thái', key: 'statusValue', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.commit();

    // Timeline đang sort giảm dần → export giảm dần, STT ngược
    timeline.forEach((item, idx) => {
      sheet
        .addRow({
          stt: idx + 1,
          code: item.code,
          date: fmtDate(item.date),
          type: TYPE_LABEL[item.type] ?? item.type,
          customerCode: item.customerCode ?? '',
          customerName: item.customerName ?? '',
          branch: (item.branch as any)?.name ?? '',
          user: (item.user as any)?.name ?? '',
          amount: Number(item.amount),
          debtSnapshot: Number(item.debtSnapshot),
          statusValue: item.statusValue ?? '',
        })
        .commit();
    });

    await workbook.commit();
  }

  // ── Export công nợ chi tiết (hóa đơn còn nợ) ────────────────────────────────
  async exportCustomerDebt(
    customerId: number,
    options: {
      fromDate?: string;
      toDate?: string;
      includeDetails?: boolean;
      showUnit?: boolean;
      showQty?: boolean;
      showPrice?: boolean;
      showDiscount?: boolean;
      showTotal?: boolean;
      showNote?: boolean;
    },
    res: Response,
  ): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        code: true,
        name: true,
        contactNumber: true,
        totalDebt: true,
      },
    });
    if (!customer) throw new NotFoundException('Không tìm thấy khách hàng');

    // ── 1. Lấy timeline + filter date ───────────────────────────────────────
    const { data: rawTimeline } = await this.getDebtTimeline(customerId, false);

    let timeline = [...rawTimeline].reverse(); // sort tăng dần (cũ → mới)
    if (options.fromDate) {
      const from = new Date(options.fromDate);
      timeline = timeline.filter((i) => new Date(i.date) >= from);
    }
    if (options.toDate) {
      const to = new Date(options.toDate);
      to.setHours(23, 59, 59, 999);
      timeline = timeline.filter((i) => new Date(i.date) <= to);
    }

    // ── 2. Tính Nợ đầu kỳ / Phát sinh / Nợ cuối kỳ ────────────────────────
    let totalDebit = 0;
    let totalCredit = 0;
    for (const item of timeline) {
      if (item.type === 'invoice' || item.type === 'expense') {
        totalDebit += Number(item.amount);
      } else {
        totalCredit += Number(item.amount);
      }
    }
    const noCuoiKy = Number(customer.totalDebt ?? 0);
    const noDauKy = noCuoiKy - (totalDebit - totalCredit);

    // ── 3. Batch fetch InvoiceDetail + ReturnOrderDetail ────────────────────
    const invoiceIds = timeline
      .filter((i) => i.type === 'invoice')
      .map((i) => i.id as number);
    const returnOrderIds = timeline
      .filter((i) => i.type === 'return_order')
      .map((i) => i.id as number);

    const [invoiceDetails, returnOrderDetails] = await Promise.all([
      invoiceIds.length > 0
        ? this.prisma.invoiceDetail.findMany({
            where: { invoiceId: { in: invoiceIds } },
            select: {
              invoiceId: true,
              productCode: true,
              productName: true,
              quantity: true,
              price: true,
              discount: true,
              totalPrice: true,
              note: true,
              product: { select: { unit: true } },
            },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
      returnOrderIds.length > 0
        ? this.prisma.returnOrderDetail.findMany({
            where: { returnOrderId: { in: returnOrderIds } },
            select: {
              returnOrderId: true,
              productCode: true,
              productName: true,
              confirmedQuantity: true,
              returnPrice: true,
              totalAmount: true,
              note: true,
              product: { select: { unit: true } },
            },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    // Build Maps để O(1) lookup
    const invDetailMap = new Map<number, any[]>();
    for (const d of invoiceDetails) {
      if (!invDetailMap.has(d.invoiceId)) invDetailMap.set(d.invoiceId, []);
      invDetailMap.get(d.invoiceId)!.push(d);
    }

    const roDetailMap = new Map<number, any[]>();
    for (const d of returnOrderDetails) {
      if (!roDetailMap.has(d.returnOrderId))
        roDetailMap.set(d.returnOrderId, []);
      roDetailMap.get(d.returnOrderId)!.push(d);
    }

    // ── 4. Helper format ─────────────────────────────────────────────────────
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDate = (d: any) => {
      if (!d) return '';
      const dt = new Date(d);
      return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    };

    const TYPE_LABEL: Record<string, string> = {
      invoice: 'Bán hàng',
      payment: 'Thanh toán',
      expense: 'Hoàn tiền',
      return_order: 'Trả hàng',
      debt_offset: 'Cấn trừ nợ',
    };

    // ── 5. Build workbook (non-streaming) ────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Công nợ chi tiết');

    // Column widths (A=STT, B=Thời gian, C=Mã, D=Diễn giải, E=DVT, F=SL,
    //               G=Đơn giá, H=Giảm giá, I=VAT, J=Giá bán/trả,
    //               K=Thành tiền, L=Ghi nợ, M=Ghi có)
    const COL_WIDTHS = [6, 20, 16, 36, 8, 10, 14, 12, 8, 14, 14, 16, 16];
    COL_WIDTHS.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    // ── Header rows ──────────────────────────────────────────────────────────
    // Row 1–3: Company info (placeholder – có thể customize sau)
    sheet.addRow(['HiSweetie']);
    sheet.addRow([]);
    sheet.addRow([]);

    // Row 4: Title (centered)
    const titleRow = sheet.addRow([
      '',
      '',
      '',
      '',
      '',
      '',
      'Công nợ chi tiết khách hàng',
    ]);
    titleRow.getCell(7).font = { bold: true, size: 14 };
    titleRow.getCell(7).alignment = { horizontal: 'center' };

    sheet.addRow([]);

    // Row 6: Customer info + summary
    const r6 = sheet.addRow([
      'Khách hàng',
      customer.name,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Nợ đầu kỳ',
      noDauKy,
    ]);
    r6.getCell(1).font = { bold: true };
    r6.getCell(12).font = { bold: true };

    const r7 = sheet.addRow([
      'Mã KH',
      customer.code ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Phát sinh trong kỳ',
      totalDebit,
      totalCredit,
    ]);
    r7.getCell(1).font = { bold: true };
    r7.getCell(12).font = { bold: true };

    const r8 = sheet.addRow([
      'Điện thoại',
      customer.contactNumber ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Nợ cuối kỳ',
      noCuoiKy,
    ]);
    r8.getCell(1).font = { bold: true };
    r8.getCell(12).font = { bold: true };

    sheet.addRow([]);

    // ── Column header row ────────────────────────────────────────────────────
    const HEADER_FILL: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    const hRow = sheet.addRow([
      '',
      'Thời gian',
      'Mã',
      'Diễn giải',
      'DVT',
      'SL',
      'Đơn giá',
      'Giảm giá',
      'VAT',
      'Giá bán/trả',
      'Thành tiền',
      'Ghi nợ',
      'Ghi có',
    ]);
    hRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    });

    // ── Data rows ────────────────────────────────────────────────────────────
    let stt = 0;
    const numFmt = '#,##0';

    for (const item of timeline) {
      const isDebit = item.type === 'invoice' || item.type === 'expense';
      const debit = isDebit ? Number(item.amount) : null;
      const credit = !isDebit ? Number(item.amount) : null;

      stt++;

      // Main transaction row
      const mainRow = sheet.addRow([
        stt,
        fmtDate(item.date),
        item.code,
        TYPE_LABEL[item.type] ?? item.type,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        debit ?? '',
        credit ?? '',
      ]);
      mainRow.getCell(1).alignment = { horizontal: 'center' };
      mainRow.getCell(12).numFmt = numFmt;
      mainRow.getCell(13).numFmt = numFmt;
      if (isDebit) {
        mainRow.getCell(12).font = { color: { argb: 'FFCC0000' } };
      } else {
        mainRow.getCell(13).font = { color: { argb: 'FF006600' } };
      }

      // Sub-rows: Invoice details
      if (options.includeDetails && item.type === 'invoice') {
        const details = invDetailMap.get(item.id as number) ?? [];
        for (const d of details) {
          const unitPrice = Number(d.price);
          const discountPerUnit = Number(d.discount);
          const salePrice = unitPrice - discountPerUnit;
          const qty = Number(d.quantity);

          const subRow = sheet.addRow([
            '',
            '',
            d.productCode,
            d.productName + (d.note ? ` (${d.note})` : ''),
            options.showUnit ? ((d.product as any)?.unit ?? '') : '',
            options.showQty ? qty : '',
            options.showPrice ? unitPrice : '',
            options.showDiscount ? discountPerUnit : '',
            0, // VAT
            options.showTotal ? salePrice : '',
            options.showTotal ? Number(d.totalPrice) : '',
            '',
            '',
          ]);

          subRow.font = { color: { argb: 'FF444444' } };
          subRow.getCell(7).numFmt = numFmt;
          subRow.getCell(8).numFmt = numFmt;
          subRow.getCell(10).numFmt = numFmt;
          subRow.getCell(11).numFmt = numFmt;
        }
      }

      // Sub-rows: Return order details
      if (options.includeDetails && item.type === 'return_order') {
        const details = roDetailMap.get(item.id as number) ?? [];
        for (const d of details) {
          const returnPrice = Number(d.returnPrice);
          const qty = Number(d.confirmedQuantity);

          const subRow = sheet.addRow([
            '',
            '',
            d.productCode,
            d.productName + (d.note ? ` (${d.note})` : ''),
            options.showUnit ? ((d.product as any)?.unit ?? '') : '',
            options.showQty ? qty : '',
            options.showPrice ? returnPrice : '',
            options.showDiscount ? 0 : '',
            0, // VAT
            options.showTotal ? returnPrice : '',
            options.showTotal ? Number(d.totalAmount) : '',
            '',
            '',
          ]);

          subRow.font = { color: { argb: 'FF444444' } };
          subRow.getCell(7).numFmt = numFmt;
          subRow.getCell(10).numFmt = numFmt;
          subRow.getCell(11).numFmt = numFmt;
        }
      }
    }

    // ── Tổng cộng ────────────────────────────────────────────────────────────
    const totalRow = sheet.addRow([
      '',
      'Tổng cộng',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      totalDebit,
      totalCredit,
    ]);
    totalRow.getCell(2).font = { bold: true };
    totalRow.getCell(12).font = { bold: true };
    totalRow.getCell(13).font = { bold: true };
    totalRow.getCell(12).numFmt = numFmt;
    totalRow.getCell(13).numFmt = numFmt;

    // ── Stream ra response ───────────────────────────────────────────────────
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await workbook.xlsx.write(res);
    res.end();
  }
}
