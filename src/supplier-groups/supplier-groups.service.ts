import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupplierGroupDto, UpdateSupplierGroupDto } from './dto';

@Injectable()
export class SupplierGroupsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const groups = await this.prisma.supplierGroup.findMany({
      include: {
        creator: {
          select: { id: true, name: true },
        },
        _count: {
          select: { supplierGroupDetails: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { data: groups };
  }

  async findOne(id: number) {
    const group = await this.prisma.supplierGroup.findUnique({
      where: { id },
      include: {
        creator: {
          select: { id: true, name: true },
        },
        supplierGroupDetails: {
          include: {
            supplier: true,
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Supplier group with id ${id} not found`);
    }

    return group;
  }

  async create(dto: CreateSupplierGroupDto, userId: number) {
    return this.prisma.supplierGroup.create({
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

  async update(id: number, dto: UpdateSupplierGroupDto) {
    const group = await this.prisma.supplierGroup.findUnique({
      where: { id },
    });

    if (!group) {
      throw new NotFoundException(`Supplier group with id ${id} not found`);
    }

    return this.prisma.supplierGroup.update({
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
    const group = await this.prisma.supplierGroup.findUnique({
      where: { id },
      include: {
        _count: {
          select: { supplierGroupDetails: true },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Supplier group with id ${id} not found`);
    }

    if (group._count.supplierGroupDetails > 0) {
      throw new Error('Không thể xóa nhóm nhà cung cấp đang có nhà cung cấp');
    }

    await this.prisma.supplierGroup.delete({
      where: { id },
    });

    return { message: 'Xóa nhóm nhà cung cấp thành công' };
  }

  async addSuppliersToGroup(groupId: number, supplierIds: number[]) {
    const group = await this.prisma.supplierGroup.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException(
        `Supplier group with id ${groupId} not found`,
      );
    }

    await this.prisma.supplierGroupDetail.createMany({
      data: supplierIds.map((supplierId) => ({
        supplierGroupId: groupId,
        supplierId,
      })),
      skipDuplicates: true,
    });

    return { message: 'Thêm nhà cung cấp vào nhóm thành công' };
  }

  async removeSuppliersFromGroup(groupId: number, supplierIds: number[]) {
    await this.prisma.supplierGroupDetail.deleteMany({
      where: {
        supplierGroupId: groupId,
        supplierId: { in: supplierIds },
      },
    });

    return { message: 'Xóa nhà cung cấp khỏi nhóm thành công' };
  }
}
