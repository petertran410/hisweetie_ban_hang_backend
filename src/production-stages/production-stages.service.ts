import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductionStagesService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeInactive = false) {
    return this.prisma.purchaseOrderProductionStage.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const stage = await this.prisma.purchaseOrderProductionStage.findUnique({
      where: { id },
    });
    if (!stage) throw new NotFoundException('Không tìm thấy giai đoạn');
    return stage;
  }

  async create(
    dto: { name: string; description?: string; isActive?: boolean },
    userId: number,
  ) {
    const name = (dto.name || '').trim();
    if (!name)
      throw new BadRequestException('Tên giai đoạn không được để trống');
    const existing = await this.prisma.purchaseOrderProductionStage.findFirst({
      where: { name },
    });
    if (existing) {
      throw new BadRequestException(`Giai đoạn "${name}" đã tồn tại`);
    }
    return this.prisma.purchaseOrderProductionStage.create({
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
        throw new BadRequestException('Tên giai đoạn không được để trống');
      }
      const dup = await this.prisma.purchaseOrderProductionStage.findFirst({
        where: { name, id: { not: id } },
      });
      if (dup) throw new BadRequestException(`Giai đoạn "${name}" đã tồn tại`);
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return this.prisma.purchaseOrderProductionStage.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    // Soft delete: chặn xóa cứng nếu đang được dùng; chỉ ẩn đi.
    const used = await this.prisma.orderSupplierItem.count({
      where: { productionStageId: id },
    });
    if (used > 0) {
      return this.prisma.purchaseOrderProductionStage.update({
        where: { id },
        data: { isActive: false },
      });
    }
    return this.prisma.purchaseOrderProductionStage.delete({ where: { id } });
  }
}
