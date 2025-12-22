import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerGroupDto, UpdateCustomerGroupDto } from './dto';

@Injectable()
export class CustomerGroupsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const groups = await this.prisma.customerGroup.findMany({
      include: {
        creator: {
          select: { id: true, name: true },
        },
        customerGroupDetails: {
          include: {
            customer: {
              select: { id: true, code: true, name: true },
            },
          },
        },
        _count: {
          select: { customerGroupDetails: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      total: groups.length,
      data: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        createdDate: group.createdAt,
        createdBy: group.createdBy,
        customerGroupDetails: group.customerGroupDetails.map((detail) => ({
          id: detail.id,
          customerId: detail.customerId,
          groupId: detail.customerGroupId,
        })),
      })),
    };
  }

  async findOne(id: number) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: {
        creator: {
          select: { id: true, name: true },
        },
        customerGroupDetails: {
          include: {
            customer: {
              select: { id: true, code: true, name: true, contactNumber: true },
            },
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      createdDate: group.createdAt,
      createdBy: group.createdBy,
      customerGroupDetails: group.customerGroupDetails.map((detail) => ({
        id: detail.id,
        customerId: detail.customerId,
        groupId: detail.customerGroupId,
        customer: detail.customer,
      })),
    };
  }

  async create(dto: CreateCustomerGroupDto, userId?: number) {
    return this.prisma.customerGroup.create({
      data: {
        name: dto.name,
        description: dto.description,
        createdBy: userId,
      },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });
  }

  async update(id: number, dto: UpdateCustomerGroupDto) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }

    return this.prisma.customerGroup.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
      },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });
  }

  async remove(id: number) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: {
        _count: {
          select: { customerGroupDetails: true },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Customer group with id ${id} not found`);
    }

    if (group._count.customerGroupDetails > 0) {
      throw new Error('Không thể xóa nhóm khách hàng đang có khách hàng');
    }

    await this.prisma.customerGroup.delete({
      where: { id },
    });

    return { message: 'Xóa nhóm khách hàng thành công' };
  }

  async addCustomersToGroup(groupId: number, customerIds: number[]) {
    const group = await this.prisma.customerGroup.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException(
        `Customer group with id ${groupId} not found`,
      );
    }

    await this.prisma.customerGroupDetail.createMany({
      data: customerIds.map((customerId) => ({
        customerGroupId: groupId,
        customerId,
      })),
      skipDuplicates: true,
    });

    return { message: 'Thêm khách hàng vào nhóm thành công' };
  }

  async removeCustomersFromGroup(groupId: number, customerIds: number[]) {
    await this.prisma.customerGroupDetail.deleteMany({
      where: {
        customerGroupId: groupId,
        customerId: { in: customerIds },
      },
    });

    return { message: 'Xóa khách hàng khỏi nhóm thành công' };
  }
}
