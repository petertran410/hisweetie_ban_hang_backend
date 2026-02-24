import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BranchesService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters?: {
    search?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }) {
    const { search, isActive, page = 1, limit = 20 } = filters || {};

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { address: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) where.isActive = isActive;

    const [data, total] = await Promise.all([
      this.prisma.branch.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.branch.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findByUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: true,
      },
    });

    if (user?.branchId) {
      return [user.branch];
    }

    return this.findAll();
  }

  async findOne(id: number) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
    });

    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(data: {
    name: string;
    code?: string;
    contactNumber?: string;
    subContactNumber?: string;
    email?: string;
    address?: string;
    locationId?: number;
    wardName?: string;
  }) {
    if (data.code) {
      const existing = await this.prisma.branch.findUnique({
        where: { code: data.code },
      });
      if (existing) {
        throw new BadRequestException('Branch code already exists');
      }
    }

    return this.prisma.branch.create({ data });
  }

  async update(
    id: number,
    data: {
      name?: string;
      code?: string;
      contactNumber?: string;
      subContactNumber?: string;
      email?: string;
      address?: string;
      locationId?: number;
      wardName?: string;
      isActive?: boolean;
      isLock?: boolean;
    },
  ) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    if (data.code && data.code !== branch.code) {
      const existing = await this.prisma.branch.findUnique({
        where: { code: data.code },
      });
      if (existing) {
        throw new BadRequestException('Branch code already exists');
      }
    }

    return this.prisma.branch.update({
      where: { id },
      data,
    });
  }

  async delete(id: number) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Branch not found');

    await this.prisma.branch.delete({ where: { id } });
    return { message: 'Branch deleted successfully' };
  }
}
