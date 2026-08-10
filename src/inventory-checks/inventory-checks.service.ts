import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInventoryCheckDto } from './dto/create-inventory-check.dto';
import { InventoryCheckQueryDto } from './dto/inventory-check-query.dto';

// LƯU Ý: module này chỉ còn phục vụ ĐỌC (tra cứu lịch sử phiếu KLB đã lập).
// Đường ghi (create/cancel) đã bị chặn nên không còn ghi audit log ở đây.

@Injectable()
export class InventoryChecksService {
  constructor(private prisma: PrismaService) {}

  /**
   * Dựng điều kiện `where` cho phiếu kiểm hàng loại B. Tách riêng để dùng chung
   * giữa findAll (danh sách) và export/export-detail, đảm bảo bộ lọc xuất file
   * khớp hoàn toàn với bộ lọc đang hiển thị.
   */
  private buildInventoryCheckWhere(query: InventoryCheckQueryDto): any {
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

  async findAll(query: InventoryCheckQueryDto) {
    const page = query.page ? +query.page : 1;
    const limit = query.limit ? +query.limit : 20;

    const where = this.buildInventoryCheckWhere(query);

    const [data, total] = await Promise.all([
      this.prisma.inventoryCheck.findMany({
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
      this.prisma.inventoryCheck.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Xuất file TỔNG QUAN: mỗi phiếu kiểm hàng loại B = 1 dòng Excel. Bộ lọc dùng
   * chung buildInventoryCheckWhere với danh sách.
   */
  async exportInventoryChecks(
    query: InventoryCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildInventoryCheckWhere(query);

    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Kiểm hàng loại B');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 20 },
      { header: 'Số sản phẩm', key: 'totalGoods', width: 12 },
      { header: 'Tổng SL loại B', key: 'totalDamaged', width: 16 },
      { header: 'Tổng SL cận date', key: 'totalNearExpiry', width: 16 },
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
      const batch = await this.prisma.inventoryCheck.findMany({
        where,
        skip: cursor,
        take: BATCH_SIZE,
        orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          creator: { select: { name: true } },
          details: {
            select: {
              damagedQuantity: true,
              nearExpiryQuantity: true,
            },
          },
        },
      });

      if (batch.length === 0) break;

      for (const c of batch) {
        const totalDamaged = c.details.reduce(
          (s, d) => s + Number(d.damagedQuantity),
          0,
        );
        const totalNearExpiry = c.details.reduce(
          (s, d) => s + Number(d.nearExpiryQuantity),
          0,
        );
        const row = sheet.addRow({
          code: c.code,
          branch: c.branchName || c.branch?.name || '',
          createdBy: c.createdByName || c.creator?.name || '',
          checkDate: fmtDateTime(c.checkDate),
          createdAt: fmtDateTime(c.createdAt),
          totalGoods: c.details.length,
          totalDamaged,
          totalNearExpiry,
          note: c.note || '',
          status: statusLabel(c.status),
        });
        row.commit();
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  /**
   * Xuất file CHI TIẾT: mỗi dòng sản phẩm trong phiếu = 1 dòng Excel, kèm thông
   * tin phiếu. Bộ lọc dùng chung buildInventoryCheckWhere với export tổng quan.
   */
  async exportInventoryChecksDetail(
    query: InventoryCheckQueryDto,
    res: Response,
  ): Promise<void> {
    const where = this.buildInventoryCheckWhere(query);

    const statusLabel = (s: number) => (s === 2 ? 'Đã hủy' : 'Hoàn thành');
    const fmtDateTime = (d?: Date | null) =>
      d ? new Date(d).toLocaleString('vi-VN') : '';

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Chi tiết kiểm hàng loại B');

    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 18 },
      { header: 'Chi nhánh', key: 'branch', width: 22 },
      { header: 'Người kiểm', key: 'createdBy', width: 20 },
      { header: 'Ngày kiểm', key: 'checkDate', width: 20 },
      { header: 'Trạng thái', key: 'status', width: 14 },
      { header: 'Mã hàng', key: 'productCode', width: 16 },
      { header: 'Tên hàng', key: 'productName', width: 36 },
      { header: 'Tồn hiện tại', key: 'currentOnHand', width: 14 },
      { header: 'Loại B trước', key: 'previousDamaged', width: 14 },
      { header: 'Cận date trước', key: 'previousNearExpiry', width: 14 },
      { header: 'SL loại B', key: 'damagedQuantity', width: 12 },
      { header: 'SL cận date', key: 'nearExpiryQuantity', width: 12 },
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
      const batch = await this.prisma.inventoryCheck.findMany({
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
          const row = sheet.addRow({
            ...base,
            productCode: '',
            productName: '',
            currentOnHand: 0,
            previousDamaged: 0,
            previousNearExpiry: 0,
            damagedQuantity: 0,
            nearExpiryQuantity: 0,
            note: '',
          });
          row.commit();
          continue;
        }

        for (const d of c.details) {
          const row = sheet.addRow({
            ...base,
            productCode: d.productCode || '',
            productName: d.productName || '',
            currentOnHand: Number(d.currentOnHand) || 0,
            previousDamaged: Number(d.previousDamaged) || 0,
            previousNearExpiry: Number(d.previousNearExpiry) || 0,
            damagedQuantity: Number(d.damagedQuantity) || 0,
            nearExpiryQuantity: Number(d.nearExpiryQuantity) || 0,
            note: d.note || '',
          });
          row.commit();
        }
      }

      cursor += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    await workbook.commit();
  }

  async findOne(id: number) {
    const record = await this.prisma.inventoryCheck.findUnique({
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

    if (!record) throw new NotFoundException('Phiếu kiểm không tồn tại');
    return record;
  }

  // ĐÃ NGỪNG SỬ DỤNG — thay thế bằng "Chuyển loại tồn" (CLT).
  //
  // Bản cũ GHI ĐÈ tuyệt đối vào cột cache Inventory.damagedQuantity /
  // nearExpiryQuantity mà KHÔNG ghi sổ cái StockConditionLog. Từ khi tồn bucket
  // được dẫn xuất từ sổ cái (tồn bucket = Σ log active), mọi màn đọc số đều lấy
  // theo sổ cái — cho tạo phiếu mới ở đây sẽ khiến cache trôi khỏi sổ cái và
  // sinh ra chênh lệch không thể tự kéo về.
  //
  // Các endpoint ĐỌC (danh sách / chi tiết / export) vẫn giữ để tra cứu lịch sử
  // các phiếu đã lập trước đây. Chỉ chặn đường GHI.
  async create(_dto: CreateInventoryCheckDto, _userId: number): Promise<never> {
    throw new BadRequestException(
      'Chức năng "Kiểm hàng loại B" đã ngừng sử dụng. Vui lòng dùng "Chuyển loại tồn" (CLT) để điều chỉnh hàng bục rách / cận date.',
    );
  }

  // ĐÃ NGỪNG SỬ DỤNG — xem ghi chú ở create().
  // Bản cũ rollback delta trực tiếp vào cột cache, cũng không ghi sổ cái.
  async cancel(_id: number, _userId?: number): Promise<never> {
    throw new BadRequestException(
      'Chức năng "Kiểm hàng loại B" đã ngừng sử dụng. Không thể hủy phiếu kiểm cũ. Vui lòng dùng "Chuyển loại tồn" (CLT).',
    );
  }
}
