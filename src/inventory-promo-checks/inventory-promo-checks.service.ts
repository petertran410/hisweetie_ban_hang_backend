import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInventoryPromoCheckDto } from './dto/create-inventory-promo-check.dto';
import { InventoryPromoCheckQueryDto } from './dto/inventory-promo-check-query.dto';

@Injectable()
export class InventoryPromoChecksService {
  constructor(private prisma: PrismaService) {}

  private buildWhere(query: InventoryPromoCheckQueryDto): any {
    const branchId = query.branchId ? +query.branchId : undefined;
    const where: any = {};

    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { createdByName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.branchIds) {
      const ids = query.branchIds
        .split(',')
        .map((id) => +id)
        .filter(Boolean);
      if (ids.length > 0) where.branchId = { in: ids };
    } else if (branchId) {
      where.branchId = branchId;
    }

    if (query.creatorId) {
      where.createdById = +query.creatorId;
    }
    if (query.productId) {
      where.details = { some: { productId: +query.productId } };
    }

    if (query.fromDate || query.toDate) {
      where.checkDate = {};
      if (query.fromDate) where.checkDate.gte = new Date(query.fromDate);
      if (query.toDate) {
        const to = new Date(query.toDate);
        to.setHours(23, 59, 59, 999);
        where.checkDate.lte = to;
      }
    }

    return where;
  }

  async findAll(query: InventoryPromoCheckQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;
    const where = this.buildWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          details: {
            include: {
              product: {
                select: { id: true, code: true, name: true, unit: true },
              },
            },
          },
        },
      }),
      this.prisma.inventoryPromoCheck.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async exportInventoryPromoChecks(
    query: InventoryPromoCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildWhere(query);
    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Kiểm hàng khuyến mãi');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Số sản phẩm', key: 'totalGoods', width: 12 },
      { header: 'Tổng SL KM', key: 'totalPromo', width: 14 },
      { header: 'Ghi chú', key: 'note', width: 30 },
      { header: 'Trạng thái', key: 'status', width: 14 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 500;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: { select: { promoQuantity: true } },
        },
      });
      if (batch.length === 0) break;

      for (const c of batch) {
        const totalPromo = c.details.reduce(
          (s, d) => s + Number(d.promoQuantity),
          0,
        );
        sheet
          .addRow({
            code: c.code,
            branch: c.branchName || c.branch?.name || '',
            createdBy: c.createdByName || c.creator?.name || '',
            checkDate: fmtDateTime(c.checkDate),
            createdAt: fmtDateTime(c.createdAt),
            totalGoods: c.details.length,
            totalPromo,
            note: c.note || '',
            status: statusLabel(c.status),
          })
          .commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async exportInventoryPromoChecksDetail(
    query: InventoryPromoCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildWhere(query);
    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết kiểm hàng KM');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'Tồn hiện tại', key: 'currentOnHand', width: 14 },
      { header: 'Loại B', key: 'currentDamaged', width: 12 },
      { header: 'Cận date', key: 'currentNearExpiry', width: 12 },
      { header: 'KM trước', key: 'previousPromoQuantity', width: 12 },
      { header: 'SL KM', key: 'promoQuantity', width: 12 },
      { header: 'Ghi chú', key: 'note', width: 30 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    headerRow.commit();

    const BATCH_SIZE = 300;
    let cursor = 0;

    while (true) {
      const batch = await this.prisma.inventoryPromoCheck.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: true,
        },
      });
      if (batch.length === 0) break;

      for (const c of batch) {
        const base = {
          code: c.code,
          branch: c.branchName || c.branch?.name || '',
          createdBy: c.createdByName || c.creator?.name || '',
          checkDate: fmtDateTime(c.checkDate),
          status: statusLabel(c.status),
        };

        if (!c.details.length) {
          sheet
            .addRow({
              ...base,
              productCode: '',
              productName: '',
              currentOnHand: 0,
              currentDamaged: 0,
              currentNearExpiry: 0,
              previousPromoQuantity: 0,
              promoQuantity: 0,
              note: '',
            })
            .commit();
          continue;
        }

        for (const d of c.details) {
          sheet
            .addRow({
              ...base,
              productCode: d.productCode || '',
              productName: d.productName || '',
              currentOnHand: Number(d.currentOnHand) || 0,
              currentDamaged: Number(d.currentDamaged) || 0,
              currentNearExpiry: Number(d.currentNearExpiry) || 0,
              previousPromoQuantity: Number(d.previousPromoQuantity) || 0,
              promoQuantity: Number(d.promoQuantity) || 0,
              note: d.note || '',
            })
            .commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const record = await this.prisma.inventoryPromoCheck.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        details: {
          include: {
            product: {
              select: { id: true, code: true, name: true, unit: true },
            },
          },
        },
      },
    });

    if (!record) throw new NotFoundException('Phiếu kiểm KM không tồn tại');
    return record;
  }

  // ĐÃ NGỪNG SỬ DỤNG — thay thế bằng "Chuyển loại tồn" (CLT).
  //
  // Bản cũ GHI ĐÈ tuyệt đối vào cột cache Inventory.promoQuantity mà KHÔNG ghi
  // sổ cái StockConditionLog. Từ khi tồn bucket được dẫn xuất từ sổ cái
  // (tồn bucket = Σ log active), mọi màn đọc số đều lấy theo sổ cái — cho tạo
  // phiếu mới ở đây sẽ khiến cache trôi khỏi sổ cái và sinh ra chênh lệch
  // không thể tự kéo về.
  //
  // Các endpoint ĐỌC (danh sách / chi tiết / export) vẫn giữ để tra cứu lịch sử
  // các phiếu đã lập trước đây. Chỉ chặn đường GHI.
  async create(
    _dto: CreateInventoryPromoCheckDto,
    _userId: number,
  ): Promise<never> {
    throw new BadRequestException(
      'Chức năng "Kiểm hàng khuyến mãi" đã ngừng sử dụng. Vui lòng dùng "Chuyển loại tồn" (CLT) để điều chỉnh tồn khuyến mãi.',
    );
  }

  // ĐÃ NGỪNG SỬ DỤNG — xem ghi chú ở create().
  // Bản cũ rollback delta trực tiếp vào cột cache, cũng không ghi sổ cái.
  async cancel(_id: number, _userId?: number): Promise<never> {
    throw new BadRequestException(
      'Chức năng "Kiểm hàng khuyến mãi" đã ngừng sử dụng. Không thể hủy phiếu kiểm cũ. Vui lòng dùng "Chuyển loại tồn" (CLT).',
    );
  }
}
