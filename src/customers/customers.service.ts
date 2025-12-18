import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto, UpdateCustomerDto, CustomerQueryDto } from './dto/';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: CustomerQueryDto) {
    const { page = 1, limit = 10, search, branchId } = query;
    const skip = (page - 1) * limit;

    const settings = await this.prisma.settings.findFirst();

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { contactNumber: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (settings?.managerCustomerByBranch && branchId) {
      where.branchId = parseInt(branchId);
    }

    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip,
        take: limit,
        include: {
          customerType: true,
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
          customerGroupDetails: {
            include: {
              customerGroup: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        customerType: true,
        branch: true,
        customerGroupDetails: {
          include: {
            customerGroup: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException(`Customer with id ${id} not found`);
    }

    return customer;
  }

  async create(dto: CreateCustomerDto) {
    const code = dto.code || (await this.generateCode());
    return this.prisma.customer.create({
      data: {
        ...dto,
        code,
      },
      include: { customerType: true },
    });
  }

  async update(id: number, dto: UpdateCustomerDto) {
    return this.prisma.customer.update({
      where: { id },
      data: dto,
      include: { customerType: true },
    });
  }

  async remove(id: number) {
    return this.prisma.customer.delete({ where: { id } });
  }

  async updateTotals(customerId: number) {
    const orders = await this.prisma.order.findMany({
      where: {
        customerId,
        orderStatus: { not: 'cancelled' },
      },
    });

    const totalPurchased = orders.reduce(
      (sum, o) => sum + Number(o.grandTotal),
      0,
    );
    const totalDebt = orders.reduce((sum, o) => sum + Number(o.debtAmount), 0);

    return this.prisma.customer.update({
      where: { id: customerId },
      data: { totalPurchased, totalDebt },
    });
  }

  private async generateCode(): Promise<string> {
    const count = await this.prisma.customer.count();
    return `KH${String(count + 1).padStart(5, '0')}`;
  }
}
