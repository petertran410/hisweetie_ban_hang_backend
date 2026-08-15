import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  FACTORY_CODE_PREFIX,
  nextFactoryCode,
} from '../common/factory-code.util';
import type { FactoryQueryDto } from './dto';

const STRATEGIC_LEVEL_LABELS: Record<string, string> = {
  STRATEGIC: 'Chiến lược',
  PREFERRED: 'Ưu tiên',
  BACKUP: 'Dự phòng',
  TRIAL: 'Thử nghiệm',
};

function strategicLevelLabel(value: string | null): string {
  if (!value) return '';
  // Tương thích dữ liệu cũ từng lưu nhãn tiếng Việt trực tiếp.
  return STRATEGIC_LEVEL_LABELS[value] || value;
}

@Injectable()
export class FactoriesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Sinh mã có thể dùng để đối chiếu/import: NM0001, NM0002, ...
   */
  private async generateCode(): Promise<string> {
    const factories = await this.prisma.factory.findMany({
      where: { code: { startsWith: FACTORY_CODE_PREFIX } },
      select: { code: true },
    });
    return nextFactoryCode(factories.map((factory) => factory.code));
  }

  private async assignGeneratedCode(id: number): Promise<string> {
    // Tối đa 10 thử, đề phòng có người dùng khác cũng đang tạo/cập nhật cùng lúc.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = await this.generateCode();
      try {
        await this.prisma.factory.update({ where: { id }, data: { code } });
        return code;
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }
    }
    throw new BadRequestException(
      'Không thể tự sinh mã nhà máy, vui lòng thử lại',
    );
  }

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
        { fullName: { contains: query.search, mode: 'insensitive' } },
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

  async exportAll(query: FactoryQueryDto = {} as FactoryQueryDto) {
    const where: any = {};
    if (!query.includeInactive) where.isActive = true;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.country) where.country = query.country;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const factories = await this.prisma.factory.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        supplier: { select: { code: true, name: true } },
        factory_products: { select: { role: true } },
      },
    });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Nhà máy');
    sheet.columns = [
      { header: 'Mã nhà máy', key: 'code', width: 16 },
      { header: 'Tên nhà máy', key: 'name', width: 26 },
      { header: 'Tên đầy đủ', key: 'fullName', width: 44 },
      { header: 'Mã NCC', key: 'supplierCode', width: 16 },
      { header: 'Nhà cung cấp', key: 'supplierName', width: 28 },
      { header: 'Quốc gia', key: 'country', width: 14 },
      { header: 'Tiền tệ', key: 'currency', width: 12 },
      { header: 'Mức độ chiến lược', key: 'strategicLevel', width: 20 },
      { header: 'Số điện thoại', key: 'contactNumber', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Wechat', key: 'wechat', width: 18 },
      { header: 'MOQ mặc định', key: 'moq', width: 16 },
      { header: 'Leadtime (ngày)', key: 'leadtimeDays', width: 18 },
      { header: 'Điều khoản thanh toán', key: 'paymentTerm', width: 30 },
      { header: 'Sản phẩm chính', key: 'primaryCount', width: 18 },
      { header: 'Sản phẩm backup', key: 'backupCount', width: 18 },
      { header: 'Trạng thái', key: 'status', width: 16 },
      { header: 'Địa chỉ', key: 'address', width: 38 },
      { header: 'Mô tả', key: 'description', width: 38 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { horizontal: 'center', wrapText: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    factories.forEach((factory) => {
      const primaryCount = factory.factory_products.filter(
        (item) => item.role === 'primary',
      ).length;
      const backupCount = factory.factory_products.filter(
        (item) => item.role === 'backup',
      ).length;
      sheet.addRow({
        code: factory.code || '',
        name: factory.name,
        fullName: factory.fullName || '',
        supplierCode: factory.supplier?.code || '',
        supplierName: factory.supplier?.name || '',
        country: factory.country || '',
        currency: factory.currency || '',
        strategicLevel: strategicLevelLabel(factory.strategicLevel),
        contactNumber: factory.contactNumber || '',
        email: factory.email || '',
        wechat: factory.wechat || '',
        moq: factory.moq == null ? '' : Number(factory.moq),
        leadtimeDays: factory.leadtimeDays ?? '',
        paymentTerm: factory.paymentTerm || '',
        primaryCount,
        backupCount,
        status: factory.isActive ? 'Hoạt động' : 'Ngừng hoạt động',
        address: factory.address || '',
        description: factory.description || '',
      });
    });
    return workbook.xlsx.writeBuffer();
  }

  async exportDetail(id: number) {
    const factory = await this.prisma.factory.findUnique({
      where: { id },
      include: {
        supplier: { select: { code: true, name: true } },
        factory_products: {
          orderBy: [{ role: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
          include: {
            products: { select: { code: true, name: true } },
          },
        },
      },
    });
    if (!factory) throw new NotFoundException('Không tìm thấy nhà máy');

    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Thông tin nhà máy');
    summary.columns = [
      { header: 'Trường thông tin', key: 'label', width: 28 },
      { header: 'Giá trị', key: 'value', width: 60 },
    ];
    summary.getRow(1).font = { bold: true };
    [
      ['Mã nhà máy', factory.code || ''],
      ['Tên nhà máy', factory.name],
      ['Tên đầy đủ', factory.fullName || ''],
      ['Mã NCC', factory.supplier?.code || ''],
      ['Nhà cung cấp', factory.supplier?.name || ''],
      ['Quốc gia', factory.country || ''],
      ['Tiền tệ', factory.currency || ''],
      ['Mức độ chiến lược', strategicLevelLabel(factory.strategicLevel)],
      ['Số điện thoại', factory.contactNumber || ''],
      ['Email', factory.email || ''],
      ['Wechat', factory.wechat || ''],
      ['MOQ mặc định', factory.moq == null ? '' : Number(factory.moq)],
      ['Leadtime (ngày)', factory.leadtimeDays ?? ''],
      ['Điều khoản thanh toán', factory.paymentTerm || ''],
      ['Trạng thái', factory.isActive ? 'Hoạt động' : 'Ngừng hoạt động'],
      ['Địa chỉ', factory.address || ''],
      ['Mô tả', factory.description || ''],
    ].forEach(([label, value]) => summary.addRow({ label, value }));

    const products = workbook.addWorksheet('Sản phẩm liên kết');
    products.columns = [
      { header: 'Mã sản phẩm', key: 'productCode', width: 18 },
      { header: 'Tên sản phẩm', key: 'productName', width: 38 },
      { header: 'Vai trò', key: 'role', width: 14 },
      { header: 'Ưu tiên', key: 'priority', width: 12 },
      { header: 'Giá tham chiếu', key: 'referencePrice', width: 18 },
      { header: 'Tiền tệ', key: 'currency', width: 12 },
      { header: 'Tỉ giá', key: 'exchangeRate', width: 14 },
      { header: 'Giá quy đổi VND', key: 'referencePriceVnd', width: 20 },
      { header: 'MOQ', key: 'moq', width: 14 },
      { header: 'Leadtime (ngày)', key: 'leadtimeDays', width: 18 },
      { header: 'Đang hoạt động', key: 'isActive', width: 18 },
      { header: 'Ghi chú', key: 'note', width: 36 },
    ];
    products.getRow(1).font = { bold: true };
    products.views = [{ state: 'frozen', ySplit: 1 }];
    factory.factory_products.forEach((mapping) => {
      const referencePrice =
        mapping.referencePrice == null ? null : Number(mapping.referencePrice);
      const exchangeRate =
        mapping.exchangeRate == null ? null : Number(mapping.exchangeRate);
      products.addRow({
        productCode: mapping.products.code,
        productName: mapping.products.name,
        role: mapping.role === 'primary' ? 'Chính' : 'Backup',
        priority: mapping.priority,
        referencePrice: referencePrice ?? '',
        currency: mapping.currency,
        exchangeRate: exchangeRate ?? '',
        referencePriceVnd:
          referencePrice == null
            ? ''
            : mapping.currency === 'VND'
              ? referencePrice
              : exchangeRate == null
                ? ''
                : referencePrice * exchangeRate,
        moq: mapping.moq == null ? '' : Number(mapping.moq),
        leadtimeDays: mapping.leadtimeDays ?? '',
        isActive: mapping.isActive ? 'Có' : 'Không',
        note: mapping.note || '',
      });
    });
    return workbook.xlsx.writeBuffer();
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
      fullName?: string;
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

    const created = await this.prisma.factory.create({
      data: {
        code: dto.code?.trim() || null,
        name,
        fullName: dto.fullName?.trim() || null,
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

    // Bỏ trống mã → tự sinh để nhà máy luôn đối chiếu được khi import.
    if (!created.code) {
      const code = await this.assignGeneratedCode(created.id);
      return { ...created, code };
    }
    return created;
  }

  async update(
    id: number,
    dto: {
      code?: string;
      name?: string;
      fullName?: string;
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
    const existing = await this.findOne(id);
    const data: any = {};

    // Form cũ gửi code rỗng khi không có mã. Thay vì ghi null, tự sinh mã để
    // những nhà máy lịch sử cũng có mã dùng cho import mapping.
    const shouldGenerateCode =
      dto.code === undefined ? !existing.code : !(dto.code || '').trim();

    if (dto.code !== undefined && !shouldGenerateCode) {
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
    if (dto.fullName !== undefined)
      data.fullName = dto.fullName?.trim() || null;
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

    const updated = await this.prisma.factory.update({ where: { id }, data });
    if (shouldGenerateCode) {
      const code = await this.assignGeneratedCode(id);
      return { ...updated, code };
    }
    return updated;
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
