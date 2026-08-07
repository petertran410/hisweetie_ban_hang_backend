import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateFactoryDto,
  FactoryQueryDto,
  UpdateFactoryDto,
} from './dto';

/**
 * Các field "phẳng" (không cần validate chéo) của Factory. Dùng chung cho
 * create/update để tránh lặp 20 dòng if giống nhau.
 */
const SCALAR_FIELDS = [
  'description',
  'country',
  'contactNumber',
  'address',
  'strategicLevel',
  'wechat',
  'email',
  'moq',
  'leadtimeDays',
  'paymentTerm',
  'port',
  'incoterm',
  'productionLeadtime',
  'shippingLeadtime',
  'customsRisk',
  'cargoType',
  'notes',
] as const;

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
    if (query.strategicLevel) where.strategicLevel = query.strategicLevel;
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
              factoryProducts: true,
            },
          },
        },
      }),
      this.prisma.factory.count({ where }),
    ]);

    // Đếm sản phẩm theo vai trò từ bảng mapping mới (FactoryProduct).
    // Prisma 4 chưa hỗ trợ filter trong `_count`, nên gom bằng groupBy rồi
    // ghép vào từng nhà máy. Hai số này là nguồn cho cột "SP chính"/"SP backup".
    const factoryIds = data.map((factory) => factory.id);
    const roleCounts = factoryIds.length
      ? await this.prisma.factoryProduct.groupBy({
          by: ['factoryId', 'role'],
          where: { factoryId: { in: factoryIds }, isActive: true },
          _count: { _all: true },
        })
      : [];

    const countMap = new Map<number, { primary: number; backup: number }>();
    for (const row of roleCounts) {
      const entry = countMap.get(row.factoryId) ?? { primary: 0, backup: 0 };
      if (row.role === 'backup') entry.backup += row._count._all;
      else entry.primary += row._count._all;
      countMap.set(row.factoryId, entry);
    }

    const enriched = data.map((factory) => ({
      ...factory,
      mappingCounts: countMap.get(factory.id) ?? { primary: 0, backup: 0 },
    }));

    return { data: enriched, total, page, limit };
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
            factoryProducts: true,
          },
        },
      },
    });
    if (!factory) throw new NotFoundException('Không tìm thấy nhà máy');
    return factory;
  }

  async create(dto: CreateFactoryDto, userId: number) {
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

    const data: any = {
      code: dto.code?.trim() || null,
      name,
      currency: dto.currency || 'VND',
      supplierId: dto.supplierId ?? null,
      isActive: dto.isActive ?? true,
      createdBy: userId,
    };
    // Gán các field phẳng (thương mại + logistics) nếu client có truyền.
    for (const field of SCALAR_FIELDS) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }

    return this.prisma.factory.create({ data });
  }

  async update(id: number, dto: UpdateFactoryDto) {
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
    // Gán các field phẳng: chỉ ghi khi client thực sự truyền (undefined = bỏ qua).
    for (const field of SCALAR_FIELDS) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }
    if (dto.currency !== undefined) data.currency = dto.currency;
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
