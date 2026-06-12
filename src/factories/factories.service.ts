import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FactoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeInactive = false) {
    return this.prisma.factory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const factory = await this.prisma.factory.findUnique({ where: { id } });
    if (!factory) throw new NotFoundException('Không tìm thấy nhà máy');
    return factory;
  }

  async create(
    dto: { name: string; description?: string; isActive?: boolean },
    userId: number,
  ) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Tên nhà máy không được để trống');
    const existing = await this.prisma.factory.findFirst({
      where: { name },
    });
    if (existing) {
      throw new BadRequestException(`Nhà máy "${name}" đã tồn tại`);
    }
    return this.prisma.factory.create({
      data: {
        name,
        description: dto.description,
        isActive: dto.isActive ?? true,
        createdBy: userId,
      },
    });
  }

  async update(
    id: number,
    dto: { name?: string; description?: string; isActive?: boolean },
  ) {
    await this.findOne(id);
    const data: any = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Tên nhà máy không được để trống');
      }
      const dup = await this.prisma.factory.findFirst({
        where: { name, id: { not: id } },
      });
      if (dup) throw new BadRequestException(`Nhà máy "${name}" đã tồn tại`);
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return this.prisma.factory.update({ where: { id }, data });
  }

  async remove(id: number) {
    await this.findOne(id);
    // Soft delete: chặn xóa cứng nếu đang được dùng; chỉ ẩn đi.
    const used = await this.prisma.orderSupplierItem.count({
      where: { factoryId: id },
    });
    if (used > 0) {
      return this.prisma.factory.update({
        where: { id },
        data: { isActive: false },
      });
    }
    return this.prisma.factory.delete({ where: { id } });
  }
}
