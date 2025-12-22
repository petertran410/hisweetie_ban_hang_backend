import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  CustomerQueryDto,
  BulkCreateCustomerDto,
  BulkUpdateCustomerDto,
} from './dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: CustomerQueryDto) {
    const {
      code,
      name,
      contactNumber,
      lastModifiedFrom,
      pageSize = 20,
      currentItem = 0,
      orderBy = 'createdAt',
      orderDirection = 'asc',
      includeRemoveIds = false,
      includeTotal = false,
      includeCustomerGroup = false,
      birthDate,
      groupId,
      includeCustomerSocial = false,
    } = query;

    const where: any = { isActive: true };

    if (code) {
      where.code = { contains: code, mode: 'insensitive' };
    }

    if (name) {
      where.name = { contains: name, mode: 'insensitive' };
    }

    if (contactNumber) {
      where.contactNumber = { contains: contactNumber };
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

    if (groupId) {
      where.customerGroupDetails = {
        some: { customerGroupId: groupId },
      };
    }

    const include: any = {
      customerType: true,
      branch: { select: { id: true, name: true } },
    };

    if (includeCustomerGroup) {
      include.customerGroupDetails = {
        include: {
          customerGroup: { select: { id: true, name: true } },
        },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip: currentItem,
        take: Math.min(pageSize, 100),
        include,
        orderBy: { [orderBy]: orderDirection },
      }),
      this.prisma.customer.count({ where }),
    ]);

    const response: any = { total, pageSize, data };

    if (includeRemoveIds && lastModifiedFrom) {
      const removedIds = await this.prisma.customer.findMany({
        where: {
          isActive: false,
          updatedAt: { gte: new Date(lastModifiedFrom) },
        },
        select: { id: true },
      });
      response.removeIds = removedIds.map((r) => r.id);
    }

    return response;
  }

  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        customerType: true,
        branch: true,
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
    };
  }

  async create(dto: CreateCustomerDto) {
    const code = dto.code || (await this.generateCode());

    const { groupIds, ...customerData } = dto;

    const customer = await this.prisma.$transaction(async (tx) => {
      const newCustomer = await tx.customer.create({
        data: {
          ...customerData,
          code,
        },
        include: {
          customerType: true,
          branch: true,
        },
      });

      if (groupIds && groupIds.length > 0) {
        await tx.customerGroupDetail.createMany({
          data: groupIds.map((groupId) => ({
            customerId: newCustomer.id,
            customerGroupId: groupId,
          })),
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

    return {
      ...customer,
      customerGroupDetails: customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
      })),
    };
  }

  async update(id: number, dto: UpdateCustomerDto) {
    const { groupIds, ...customerData } = dto;

    const customer = await this.prisma.$transaction(async (tx) => {
      const updatedCustomer = await tx.customer.update({
        where: { id },
        data: customerData,
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
          await tx.customerGroupDetail.createMany({
            data: groupIds.map((groupId) => ({
              customerId: id,
              customerGroupId: groupId,
            })),
          });
        }
      }

      return updatedCustomer;
    });

    const groups = await this.prisma.customerGroupDetail.findMany({
      where: { customerId: id },
      include: {
        customerGroup: { select: { name: true } },
      },
    });

    return {
      ...customer,
      groups: groups.map((g) => g.customerGroup.name).join(', '),
    };
  }

  async remove(id: number) {
    await this.prisma.customer.update({
      where: { id },
      data: { isActive: false },
    });

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
}
