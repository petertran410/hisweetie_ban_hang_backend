import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { FactoryQueryDto } from './dto';

@Injectable()
export class FactoriesService {
  constructor(private prisma: PrismaService) {}

  /**
   * List nhà máy với filter:
   * - supplierId: lọc theo NCC quản lý
   * - country: lọc theo mã quốc gia
   * - search: tìm theo code hoặc name (case-insensitive)
   * - includeInactive: mặc định false (chỉ trả isActive=true)
   * - page/limit/orderBy/orderDirection: phân trang + sort
   */
  async findAll(query: FactoryQueryDto = {} as FactoryQueryDto) {
    const where: any = {};
    if (!query.includeInactive) where.isActive = true;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.country) where.country = query.country;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;
    const orderBy: any =
      query.orderBy === 'code'
        ? { code: query.orderDirection ?? 'asc' }
        : query.orderBy === 'createdAt'
          ? { createdAt: query.orderDirection ?? 'desc' }
          : { name: query.orderDirection ?? 'asc' };

    const [data, total] = await Promise.all([
      this.prisma.factory.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          supplier: { select: { id: true, name: true, code: true } },
          _count: {
            select: {
              primaryForProducts: true,
              backupForProducts: true,
            },
          },
        },
      }),
      this.prisma.factory.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Lấy tất cả nhà máy (active) thuộc 1 NCC — dùng cho dropdown filter
   * trong OrderSupplierForm / các ngữ cảnh khác.
   */
  async getBySupplier(supplierId: number) {
    return this.prisma.factory.findMany({
      where: { supplierId, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        country: true,
        currency: true,
        supplierId: true,
      },
    });
  }

  /**
   * Danh sách Product gắn với nhà máy này (chia theo vai trò primary/backup).
   * Read-only — dùng cho trang /san-pham/nha-may/[id]/san-pham.
   */
  async getProductsByFactory(factoryId: number) {
    await this.findOne(factoryId);
    const [primary, backup] = await Promise.all([
      this.prisma.product.findMany({
        where: { primaryFactoryId: factoryId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
          images: {
            take: 1,
            orderBy: { id: 'asc' },
            select: { image: true },
          },
        },
      }),
      this.prisma.product.findMany({
        where: { backupFactoryId: factoryId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
          images: {
            take: 1,
            orderBy: { id: 'asc' },
            select: { image: true },
          },
        },
      }),
    ]);
    return { primary, backup };
  }

  async findOne(id: number) {
    const factory = await this.prisma.factory.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, code: true } },
        _count: {
          select: {
            primaryForProducts: true,
            backupForProducts: true,
            orderSupplierItems: true,
          },
        },
      },
    });
    if (!factory) throw new NotFoundException('Không tìm thấy nhà máy');
    return factory;
  }

  async create(
    dto: {
      code?: string;
      name: string;
      description?: string;
      strategicLevel?: string;
      wechat?: string;
      email?: string;
      moq?: number;
      leadtimeDays?: number;
      paymentTerm?: string;
      country?: string;
      currency?: string;
      contactNumber?: string;
      address?: string;
      supplierId?: number;
      isActive?: boolean;
    },
    userId: number,
  ) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Tên nhà máy không được để trống');

    // Validate code unique nếu được truyền
    if (dto.code) {
      const code = dto.code.trim();
      const dupCode = await this.prisma.factory.findUnique({
        where: { code },
      });
      if (dupCode) {
        throw new BadRequestException(`Mã nhà máy "${code}" đã tồn tại`);
      }
      dto.code = code;
    }

    // Validate tên trùng
    const dupName = await this.prisma.factory.findFirst({ where: { name } });
    if (dupName) {
      throw new BadRequestException(`Nhà máy "${name}" đã tồn tại`);
    }

    // Validate supplierId tồn tại nếu được truyền
    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: dto.supplierId },
        select: { id: true },
      });
      if (!supplier) {
        throw new BadRequestException(
          `Nhà cung cấp ID ${dto.supplierId} không tồn tại`,
        );
      }
    }

    return this.prisma.factory.create({
      data: {
        code: dto.code?.trim() || null,
        name,
        description: dto.description,
        strategicLevel: dto.strategicLevel,
        wechat: dto.wechat,
        email: dto.email,
        moq: dto.moq,
        leadtimeDays: dto.leadtimeDays,
        paymentTerm: dto.paymentTerm,
        country: dto.country,
        currency: dto.currency || 'VND',
        contactNumber: dto.contactNumber,
        address: dto.address,
        supplierId: dto.supplierId ?? null,
        isActive: dto.isActive ?? true,
        createdBy: userId,
      },
    });
  }

  async update(
    id: number,
    dto: {
      code?: string;
      name?: string;
      description?: string;
      strategicLevel?: string;
      wechat?: string;
      email?: string;
      moq?: number;
      leadtimeDays?: number;
      paymentTerm?: string;
      country?: string;
      currency?: string;
      contactNumber?: string;
      address?: string;
      supplierId?: number;
      isActive?: boolean;
    },
  ) {
    await this.findOne(id);
    const data: any = {};

    if (dto.code !== undefined) {
      const code = (dto.code || '').trim() || null;
      if (code) {
        const dup = await this.prisma.factory.findFirst({
          where: { code, id: { not: id } },
        });
        if (dup) {
          throw new BadRequestException(`Mã nhà máy "${code}" đã tồn tại`);
        }
      }
      data.code = code;
    }

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
    if (dto.strategicLevel !== undefined)
      data.strategicLevel = dto.strategicLevel;
    if (dto.wechat !== undefined) data.wechat = dto.wechat;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.moq !== undefined) data.moq = dto.moq;
    if (dto.leadtimeDays !== undefined) data.leadtimeDays = dto.leadtimeDays;
    if (dto.paymentTerm !== undefined) data.paymentTerm = dto.paymentTerm;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.contactNumber !== undefined) data.contactNumber = dto.contactNumber;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.supplierId !== undefined) {
      if (dto.supplierId !== null) {
        const supplier = await this.prisma.supplier.findUnique({
          where: { id: dto.supplierId },
          select: { id: true },
        });
        if (!supplier) {
          throw new BadRequestException(
            `Nhà cung cấp ID ${dto.supplierId} không tồn tại`,
          );
        }
      }
      data.supplierId = dto.supplierId;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.factory.update({ where: { id }, data });
  }

  async remove(id: number) {
    await this.findOne(id);
    // Soft delete: chặn xóa cứng nếu đang được dùng; chỉ ẩn đi.
    // Kiểm tra cả Product (primary/backup) + OrderSupplierItem (factoryId).
    const [usedInProductPrimary, usedInProductBackup, usedInItem] =
      await Promise.all([
        this.prisma.product.count({ where: { primaryFactoryId: id } }),
        this.prisma.product.count({ where: { backupFactoryId: id } }),
        this.prisma.orderSupplierItem.count({ where: { factoryId: id } }),
      ]);
    const totalUsage = usedInProductPrimary + usedInProductBackup + usedInItem;
    if (totalUsage > 0) {
      // Đang được sử dụng → soft-delete
      return this.prisma.factory.update({
        where: { id },
        data: { isActive: false },
      });
    }
    return this.prisma.factory.delete({ where: { id } });
  }
}
