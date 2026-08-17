import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { toVnd } from '../common/currency.util';

const REQUIRED_HEADERS = ['mã sản phẩm', 'mã nhà máy'];

const HEADER_KEYS: Record<string, keyof ParsedRow | undefined> = {
  'mã sản phẩm': 'productCode',
  'ma san pham': 'productCode',
  sku: 'productCode',
  'product code': 'productCode',
  'mã nhà máy': 'factoryCode',
  'ma nha may': 'factoryCode',
  'factory code': 'factoryCode',
  'vai trò': 'role',
  'vai tro': 'role',
  role: 'role',
  'ưu tiên': 'priority',
  'uu tien': 'priority',
  priority: 'priority',
  'giá tham chiếu': 'referencePrice',
  'gia tham chieu': 'referencePrice',
  'reference price': 'referencePrice',
  'tiền tệ': 'currency',
  'tien te': 'currency',
  currency: 'currency',
  'tỷ giá': 'exchangeRate',
  'ty gia': 'exchangeRate',
  'exchange rate': 'exchangeRate',
  moq: 'moq',
  'thời gian giao hàng (ngày)': 'leadtimeDays',
  'thoi gian giao hang (ngay)': 'leadtimeDays',
  'leadtime days': 'leadtimeDays',
  'ghi chú': 'note',
  'ghi chu': 'note',
  note: 'note',
  'kích hoạt': 'isActive',
  'kich hoat': 'isActive',
  active: 'isActive',
};

export interface ParsedRow {
  row: number;
  productCode: string;
  factoryCode: string;
  errors: string[];
  role?: 'primary' | 'backup';
  priority?: number;
  referencePrice?: number;
  currency?: string;
  exchangeRate?: number;
  moq?: number;
  leadtimeDays?: number;
  note?: string;
  isActive?: boolean;
}

export interface PreviewRow extends ParsedRow {
  product: { code: string; name: string } | null;
  factory: { code: string | null; name: string } | null;
  action: 'create' | 'update' | 'error';
}

@Injectable()
export class FactoryProductImportService {
  constructor(private prisma: PrismaService) {}

  /**
   * ExcelJS trả nhiều dạng cell: string, number, Date, formula ({result}),
   * hyperlink ({text}) hoặc rich text ({richText}). Chỉ ép kiểu các dạng
   * nguyên thủy đã biết để tránh nhận "[object Object]".
   */
  private value(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const cell = value as {
        text?: unknown;
        result?: unknown;
        richText?: Array<{ text?: unknown }>;
      };
      if (Array.isArray(cell.richText)) {
        return cell.richText
          .map((part) => this.value(part?.text))
          .join('')
          .trim();
      }
      if (cell.text !== undefined) return this.value(cell.text);
      if (cell.result !== undefined) return this.value(cell.result);
    }
    return '';
  }

  private number(
    value: string,
    field: string,
    errors: string[],
  ): number | undefined {
    if (!value) return undefined;
    const result = Number(value.replace(/,/g, '').trim());
    if (!Number.isFinite(result) || result < 0) {
      errors.push(`${field} không hợp lệ`);
      return undefined;
    }
    return result;
  }

  private bool(value: string, errors: string[]): boolean | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (['true', '1', 'có', 'co', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'không', 'khong', 'no'].includes(normalized))
      return false;
    errors.push('Kích hoạt phải là Có/Không hoặc true/false');
    return undefined;
  }

  /**
   * Cột trống → trả undefined để giữ nguyên giá trị đang có trong DB, tránh
   * việc import thiếu cột lại vô tình đổi mapping `backup` thành `primary`.
   */
  private parseRole(
    value: string,
    errors: string[],
  ): 'primary' | 'backup' | undefined {
    const normalized = value.toLowerCase();
    if (!normalized) return undefined;
    if (['primary', 'chính', 'chinh'].includes(normalized)) return 'primary';
    if (['backup', 'dự phòng', 'du phong'].includes(normalized))
      return 'backup';
    errors.push('Vai trò phải là primary hoặc backup');
    return undefined;
  }

  private async parse(file: Express.Multer.File): Promise<ParsedRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet =
      workbook.getWorksheet('FactoryProductMapping') || workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống');

    const columns: Partial<Record<keyof ParsedRow, number>> = {};
    sheet.getRow(1).eachCell((cell, index) => {
      const key = HEADER_KEYS[this.value(cell.value).toLowerCase()];
      if (key) columns[key] = index;
    });

    const missing = REQUIRED_HEADERS.filter((header) => {
      const key = HEADER_KEYS[header];
      return !key || !columns[key];
    });
    if (missing.length) {
      throw new BadRequestException(
        `Thiếu cột bắt buộc: ${missing.join(', ')}`,
      );
    }

    const cell = (row: ExcelJS.Row, key: keyof ParsedRow) => {
      const index = columns[key];
      return index ? this.value(row.getCell(index).value) : '';
    };
    const rows: ParsedRow[] = [];

    sheet.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return;
      const productCode = cell(excelRow, 'productCode');
      const factoryCode = cell(excelRow, 'factoryCode');
      if (!productCode && !factoryCode) return;

      const errors: string[] = [];
      if (!productCode) errors.push('Thiếu mã sản phẩm');
      if (!factoryCode) errors.push('Thiếu mã nhà máy');
      rows.push({
        row: rowNumber,
        productCode,
        factoryCode,
        errors,
        role: this.parseRole(cell(excelRow, 'role'), errors),
        priority: this.number(cell(excelRow, 'priority'), 'Ưu tiên', errors),
        referencePrice: this.number(
          cell(excelRow, 'referencePrice'),
          'Giá tham chiếu',
          errors,
        ),
        currency: cell(excelRow, 'currency').toUpperCase() || undefined,
        exchangeRate: this.number(
          cell(excelRow, 'exchangeRate'),
          'Tỷ giá',
          errors,
        ),
        moq: this.number(cell(excelRow, 'moq'), 'MOQ', errors),
        leadtimeDays: this.number(
          cell(excelRow, 'leadtimeDays'),
          'Thời gian giao hàng',
          errors,
        ),
        note: cell(excelRow, 'note') || undefined,
        isActive: this.bool(cell(excelRow, 'isActive'), errors),
      });
    });

    return rows;
  }

  async preview(file: Express.Multer.File) {
    const rows = await this.parse(file);
    const productCodes = [...new Set(rows.map((row) => row.productCode))];
    const factoryCodes = [...new Set(rows.map((row) => row.factoryCode))];
    const [products, factories] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where: { code: { in: productCodes } },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.factory.findMany({
        where: { code: { in: factoryCodes } },
        select: { id: true, code: true, name: true, currency: true },
      }),
    ]);
    const productMap = new Map(
      products.map((product) => [product.code, product]),
    );
    const factoryMap = new Map(
      factories.map((factory) => [factory.code || '', factory]),
    );

    const pairs = rows
      .filter((row) => !row.errors.length)
      .map((row) => ({
        factoryId: factoryMap.get(row.factoryCode)?.id,
        productId: productMap.get(row.productCode)?.id,
      }))
      .filter(
        (pair): pair is { factoryId: number; productId: number } =>
          pair.factoryId != null && pair.productId != null,
      );
    const existing = pairs.length
      ? await this.prisma.factory_products.findMany({
          where: { OR: pairs },
          select: { factoryId: true, productId: true },
        })
      : [];
    const existingSet = new Set(
      existing.map((mapping) => `${mapping.factoryId}:${mapping.productId}`),
    );
    const seen = new Set<string>();

    const result: PreviewRow[] = rows.map((row) => {
      const product = productMap.get(row.productCode);
      const factory = factoryMap.get(row.factoryCode);
      if (!product) {
        row.errors.push(`Không tìm thấy sản phẩm mã "${row.productCode}"`);
      }
      if (!factory) {
        row.errors.push(`Không tìm thấy nhà máy mã "${row.factoryCode}"`);
      }
      const key = `${row.factoryCode}:${row.productCode}`;
      if (seen.has(key)) row.errors.push('Trùng mapping trong file');
      seen.add(key);
      const pairKey = product && factory ? `${factory.id}:${product.id}` : '';
      return {
        ...row,
        product: product ? { code: product.code, name: product.name } : null,
        factory: factory ? { code: factory.code, name: factory.name } : null,
        action: row.errors.length
          ? 'error'
          : existingSet.has(pairKey)
            ? 'update'
            : 'create',
      };
    });

    return {
      total: result.length,
      valid: result.filter((row) => !row.errors.length).length,
      invalid: result.filter((row) => row.errors.length).length,
      create: result.filter((row) => row.action === 'create').length,
      update: result.filter((row) => row.action === 'update').length,
      rows: result,
    };
  }

  async commit(file: Express.Multer.File, userId: number, userName?: string) {
    const preview = await this.preview(file);
    if (preview.invalid > 0) {
      throw new BadRequestException({
        message: 'File có dòng không hợp lệ, hãy sửa và kiểm tra lại',
        ...preview,
      });
    }

    // Resolve mã → id một lần trước transaction. Nếu tra cứu từng dòng bên
    // trong transaction thì file vài trăm dòng sẽ vượt timeout mặc định (5s)
    // của Prisma và rollback toàn bộ.
    const [products, factories] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where: { code: { in: preview.rows.map((row) => row.productCode) } },
        select: { id: true, code: true },
      }),
      this.prisma.factory.findMany({
        where: { code: { in: preview.rows.map((row) => row.factoryCode) } },
        select: { id: true, code: true, currency: true },
      }),
    ]);
    const productIdByCode = new Map(
      products.map((product) => [product.code, product.id]),
    );
    const factoryByCode = new Map(
      factories.map((factory) => [factory.code || '', factory]),
    );

    await this.prisma.$transaction(
      async (tx) => {
        for (const row of preview.rows) {
          const productId = productIdByCode.get(row.productCode);
          const factory = factoryByCode.get(row.factoryCode);
          if (productId == null || !factory) {
            throw new BadRequestException(
              `Dòng ${row.row}: dữ liệu đã thay đổi, hãy kiểm tra lại file`,
            );
          }
          const existing = await tx.factory_products.findUnique({
            where: {
              factoryId_productId: { factoryId: factory.id, productId },
            },
          });
          const currency =
            row.currency || existing?.currency || factory.currency || 'VND';
          const exchangeRate =
            row.exchangeRate ??
            existing?.exchangeRate ??
            (currency === 'VND' ? 1 : undefined);
          const priceChanged =
            row.referencePrice !== undefined &&
            Number(existing?.referencePrice ?? -1) !== row.referencePrice;
          const data = {
            role: row.role,
            priority: row.priority,
            currency,
            exchangeRate,
            moq: row.moq,
            leadtimeDays: row.leadtimeDays,
            note: row.note,
            isActive: row.isActive,
            ...(priceChanged
              ? {
                  referencePrice: row.referencePrice,
                  priceUpdatedAt: new Date(),
                  priceUpdatedById: userId,
                }
              : {}),
          };
          const mapping = existing
            ? await tx.factory_products.update({
                where: { id: existing.id },
                data,
              })
            : await tx.factory_products.create({
                data: {
                  ...data,
                  factoryId: factory.id,
                  productId,
                  referencePrice: row.referencePrice ?? null,
                  createdBy: userId,
                  updatedAt: new Date(),
                },
              });

          if (priceChanged || (!existing && row.referencePrice !== undefined)) {
            await tx.factory_product_price_histories.create({
              data: {
                factoryProductId: mapping.id,
                oldPrice: existing?.referencePrice ?? null,
                newPrice: row.referencePrice,
                oldPriceVnd: toVnd(
                  existing?.referencePrice,
                  existing?.currency,
                  existing?.exchangeRate,
                ),
                newPriceVnd: toVnd(row.referencePrice, currency, exchangeRate),
                currency,
                exchangeRate: exchangeRate ?? null,
                eventType: 'reference',
                reason: 'Import liên kết sản phẩm - nhà máy',
                changedById: userId,
                changedByName: userName || null,
              },
            });
          }
        }
      },
      { timeout: 120_000 },
    );

    return {
      total: preview.total,
      created: preview.create,
      updated: preview.update,
    };
  }

  async template() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('FactoryProductMapping');
    worksheet.columns = [
      { header: 'Mã sản phẩm', key: 'productCode', width: 20 },
      { header: 'Mã nhà máy', key: 'factoryCode', width: 20 },
      { header: 'Vai trò', key: 'role', width: 14 },
      { header: 'Ưu tiên', key: 'priority', width: 12 },
      { header: 'Giá tham chiếu', key: 'referencePrice', width: 18 },
      { header: 'Tiền tệ', key: 'currency', width: 12 },
      { header: 'Tỷ giá', key: 'exchangeRate', width: 14 },
      { header: 'MOQ', key: 'moq', width: 12 },
      {
        header: 'Thời gian giao hàng (ngày)',
        key: 'leadtimeDays',
        width: 28,
      },
      { header: 'Ghi chú', key: 'note', width: 32 },
      { header: 'Kích hoạt', key: 'isActive', width: 14 },
    ];
    worksheet.getRow(1).font = { bold: true };
    worksheet.addRow({
      productCode: 'SP001',
      factoryCode: 'NM001',
      role: 'primary',
      priority: 0,
      referencePrice: 100000,
      currency: 'VND',
      exchangeRate: 1,
      moq: 100,
      leadtimeDays: 14,
      note: 'Dòng mẫu',
      isActive: 'Có',
    });
    return workbook.xlsx.writeBuffer();
  }
}
