import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { cleanUnitName, normalizeUnitKey } from '../common/unit.util';
import { CreateUnitDto, ReorderUnitsDto, UpdateUnitDto } from './dto';

/**
 * Danh mục Đơn vị tính. Product.unit lưu TÊN đơn vị, nên đổi tên / gộp ở đây
 * phải cập nhật luôn cột unit của các sản phẩm đang dùng (cùng transaction).
 */
@Injectable()
export class UnitsService {
  constructor(private prisma: PrismaService) {}

  /** Số sản phẩm đang dùng từng đơn vị (so theo khóa chuẩn hóa). */
  private async countProductsByKey(): Promise<Map<string, number>> {
    const groups = await this.prisma.product.groupBy({
      by: ['unit'],
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of groups) {
      const key = normalizeUnitKey(g.unit);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + g._count._all);
    }
    return counts;
  }

  async findAll(includeInactive: boolean) {
    const [units, counts] = await Promise.all([
      this.prisma.unit.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.countProductsByKey(),
    ]);
    return units.map((u) => ({
      ...u,
      productCount: counts.get(normalizeUnitKey(u.name)) ?? 0,
    }));
  }

  private async findByKey(name: string, excludeId?: number) {
    const key = normalizeUnitKey(name);
    const units = await this.prisma.unit.findMany();
    return units.find(
      (u) => normalizeUnitKey(u.name) === key && u.id !== excludeId,
    );
  }

  async create(dto: CreateUnitDto) {
    const name = cleanUnitName(dto.name);
    if (!name) throw new BadRequestException('Tên đơn vị không được trống');
    const existing = await this.findByKey(name);
    if (existing) {
      throw new ConflictException(
        `Đơn vị "${existing.name}" đã có trong danh mục${
          existing.isActive ? '' : ' (đang ẩn)'
        }`,
      );
    }
    const last = await this.prisma.unit.aggregate({
      _max: { sortOrder: true },
    });
    return this.prisma.unit.create({
      data: { name, sortOrder: (last._max.sortOrder ?? 0) + 1 },
    });
  }

  async update(id: number, dto: UpdateUnitDto) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Không tìm thấy đơn vị tính');

    if (dto.isActive === false && unit.isSystem) {
      throw new BadRequestException(
        `"${unit.name}" là đơn vị của hệ thống, không thể ẩn`,
      );
    }

    const newName =
      dto.name !== undefined ? cleanUnitName(dto.name) : undefined;
    if (newName === '') {
      throw new BadRequestException('Tên đơn vị không được trống');
    }
    const renaming = newName !== undefined && newName !== unit.name;
    if (renaming && unit.isSystem) {
      throw new BadRequestException(
        `"${unit.name}" là đơn vị của hệ thống, không thể đổi tên`,
      );
    }

    if (renaming) {
      const target = await this.findByKey(newName, id);
      if (target) {
        // Trùng tên đơn vị khác → gộp vào đơn vị đó (phải xác nhận).
        if (!dto.confirmMerge) {
          throw new ConflictException({
            code: 'UNIT_MERGE_REQUIRED',
            targetId: target.id,
            targetName: target.name,
            message: `Đã có đơn vị "${target.name}". Xác nhận gộp "${unit.name}" vào "${target.name}"?`,
          });
        }
        return this.merge(unit, target);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (renaming) {
        await tx.product.updateMany({
          where: { unit: { equals: unit.name, mode: 'insensitive' } },
          data: { unit: newName },
        });
      }
      return tx.unit.update({
        where: { id },
        data: {
          ...(renaming ? { name: newName } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    });
  }

  /** Gộp `source` vào `target`: chuyển sản phẩm sang tên target rồi xóa source. */
  private async merge(
    source: { id: number; name: string; isSystem: boolean },
    target: { id: number; name: string },
  ) {
    if (source.isSystem) {
      throw new BadRequestException(
        `"${source.name}" là đơn vị của hệ thống, không thể gộp`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({
        where: { unit: { equals: source.name, mode: 'insensitive' } },
        data: { unit: target.name },
      });
      await tx.unit.delete({ where: { id: source.id } });
      const merged = await tx.unit.findUnique({ where: { id: target.id } });
      return { ...merged, mergedProductCount: count };
    });
  }

  async remove(id: number) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Không tìm thấy đơn vị tính');
    if (unit.isSystem) {
      throw new BadRequestException(
        `"${unit.name}" là đơn vị của hệ thống, không thể xóa`,
      );
    }
    const used = (await this.countProductsByKey()).get(
      normalizeUnitKey(unit.name),
    );
    if (used) {
      throw new BadRequestException(
        `Đơn vị "${unit.name}" đang dùng cho ${used} sản phẩm — hãy ẩn hoặc gộp vào đơn vị khác`,
      );
    }
    await this.prisma.unit.delete({ where: { id } });
    return { message: 'Đã xóa đơn vị tính' };
  }

  /** Lưu thứ tự hiển thị theo danh sách id gửi lên. */
  async reorder(dto: ReorderUnitsDto) {
    await this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.unit.update({
          where: { id },
          data: { sortOrder: index + 1 },
        }),
      ),
    );
    return this.findAll(true);
  }
}
