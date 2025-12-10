import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierDto, UpdateSupplierDto, SupplierQueryDto } from './dto';

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: SupplierQueryDto) {
    const { page = 1, limit = 10, search, isActive } = query;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (isActive !== undefined) where.isActive = isActive;

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    return this.prisma.supplier.findUnique({
      where: { id },
      include: {
        purchaseOrders: {
          orderBy: { purchaseDate: 'desc' },
          take: 10,
        },
      },
    });
  }

  async create(dto: CreateSupplierDto) {
    const code = dto.code || (await this.generateCode());
    return this.prisma.supplier.create({
      data: {
        ...dto,
        code,
      },
    });
  }

  async update(id: number, dto: UpdateSupplierDto) {
    return this.prisma.supplier.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    return this.prisma.supplier.delete({ where: { id } });
  }

  async updateDebt(supplierId: number) {
    const purchaseOrders = await this.prisma.purchaseOrder.findMany({
      where: { supplierId },
    });

    const totalDebt = purchaseOrders.reduce(
      (sum, po) => sum + Number(po.debtAmount),
      0,
    );

    return this.prisma.supplier.update({
      where: { id: supplierId },
      data: { totalDebt },
    });
  }

  private async generateCode(): Promise<string> {
    const count = await this.prisma.supplier.count();
    return `NCC${String(count + 1).padStart(5, '0')}`;
  }
}
