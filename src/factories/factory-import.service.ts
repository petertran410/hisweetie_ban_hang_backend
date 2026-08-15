import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatFactoryCode,
  nextFactoryCode,
} from '../common/factory-code.util';

const REQUIRED_HEADERS = ['tên nhà máy'];

/**
 * Chuẩn hóa giá trị người dùng nhập mà không thay đổi ý nghĩa:
 * - không phân biệt chữ hoa/thường;
 * - bỏ dấu tiếng Việt và canonical Unicode (Excel có thể dùng tổ hợp dấu khác);
 * - gộp nhiều khoảng trắng.
 *
 * Không cố sửa lỗi chính tả thật sự: import phải dừng ở preview thay vì đoán
 * sai mức độ chiến lược.
 */
function normalizeStrategicLevel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

/** Giá trị hiển thị tiếng Việt → mã nội bộ dùng bởi form/UI. */
const STRATEGIC_LEVEL_VALUES: Record<string, string> = {
  'chien luoc': 'STRATEGIC',
  strategic: 'STRATEGIC',
  'uu tien': 'PREFERRED',
  preferred: 'PREFERRED',
  'du phong': 'BACKUP',
  backup: 'BACKUP',
  'thu nghiem': 'TRIAL',
  trial: 'TRIAL',
};

const HEADER_KEYS: Record<string, keyof ParsedFactoryRow | undefined> = {
  'mã nhà máy': 'code',
  'ma nha may': 'code',
  'factory code': 'code',
  'tên nhà máy': 'name',
  'ten nha may': 'name',
  'tên đầy đủ': 'fullName',
  'ten day du': 'fullName',
  'tên đầy đủ nhà máy': 'fullName',
  'ten day du nha may': 'fullName',
  'full name': 'fullName',
  'tên ncc': 'supplierName',
  'ten ncc': 'supplierName',
  'nhà cung cấp': 'supplierName',
  'nha cung cap': 'supplierName',
  'mã ncc': 'supplierCode',
  'ma ncc': 'supplierCode',
  'supplier code': 'supplierCode',
  'quốc gia': 'country',
  'quoc gia': 'country',
  country: 'country',
  'mức độ chiến lược': 'strategicLevel',
  'muc do chien luoc': 'strategicLevel',
  'strategic level': 'strategicLevel',
  wechat: 'wechat',
  email: 'email',
  moq: 'moq',
  leadtime: 'leadtimeDays',
  'leadtime (ngày)': 'leadtimeDays',
  'leadtime (ngay)': 'leadtimeDays',
  'thời gian giao hàng (ngày)': 'leadtimeDays',
  'thoi gian giao hang (ngay)': 'leadtimeDays',
  'payment term': 'paymentTerm',
  'điều khoản thanh toán': 'paymentTerm',
  'dieu khoan thanh toan': 'paymentTerm',
  status: 'isActive',
  'trạng thái': 'isActive',
  'trang thai': 'isActive',
  'số điện thoại': 'contactNumber',
  'so dien thoai': 'contactNumber',
  phone: 'contactNumber',
  'địa chỉ': 'address',
  'dia chi': 'address',
  address: 'address',
  'tiền tệ': 'currency',
  'tien te': 'currency',
  currency: 'currency',
  'ghi chú': 'description',
  'ghi chu': 'description',
  description: 'description',
};

export interface ParsedFactoryRow {
  row: number;
  code?: string;
  name: string;
  fullName?: string;
  supplierCode?: string;
  supplierName?: string;
  country?: string;
  strategicLevel?: string;
  wechat?: string;
  email?: string;
  moq?: number;
  leadtimeDays?: number;
  paymentTerm?: string;
  isActive?: boolean;
  contactNumber?: string;
  address?: string;
  currency?: string;
  description?: string;
  errors: string[];
}

export interface FactoryImportPreviewRow extends ParsedFactoryRow {
  resolvedCode?: string;
  supplier: { id: number; code: string | null; name: string } | null;
  action: 'create' | 'update' | 'error';
}

@Injectable()
export class FactoryImportService {
  constructor(private prisma: PrismaService) {}

  private value(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const cell = value as {
        text?: unknown;
        result?: unknown;
        richText?: Array<{ text?: unknown }>;
      };
      if (Array.isArray(cell.richText)) {
        return cell.richText
          .map((part) => this.value(part.text))
          .join('')
          .trim();
      }
      if (cell.text !== undefined) return this.value(cell.text);
      if (cell.result !== undefined) return this.value(cell.result);
    }
    return '';
  }

  private number(value: string, field: string, errors: string[]) {
    if (!value) return undefined;
    const parsed = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push(`${field} không hợp lệ`);
      return undefined;
    }
    return parsed;
  }

  private strategicLevel(value: string, errors: string[]): string | undefined {
    if (!value.trim()) return undefined;
    const normalized = STRATEGIC_LEVEL_VALUES[normalizeStrategicLevel(value)];
    if (normalized) return normalized;
    errors.push(
      `Mức độ chiến lược "${value.trim()}" không hợp lệ — chỉ nhận Chiến lược, Ưu tiên, Dự phòng hoặc Thử nghiệm`,
    );
    return undefined;
  }

  private bool(value: string, errors: string[]) {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (
      [
        'true',
        '1',
        'có',
        'co',
        'yes',
        'active',
        'hoạt động',
        'hoat dong',
      ].includes(normalized)
    )
      return true;
    if (
      [
        'false',
        '0',
        'không',
        'khong',
        'no',
        'inactive',
        'ngừng hoạt động',
        'ngung hoat dong',
      ].includes(normalized)
    )
      return false;
    errors.push('Trạng thái phải là Hoạt động/Ngừng hoạt động hoặc true/false');
    return undefined;
  }

  private async parse(file: Express.Multer.File): Promise<ParsedFactoryRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet = workbook.getWorksheet('Factories') || workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống');

    const columns: Partial<Record<keyof ParsedFactoryRow, number>> = {};
    sheet.getRow(1).eachCell((cell, index) => {
      const key = HEADER_KEYS[this.value(cell.value).toLowerCase()];
      if (key) columns[key] = index;
    });
    const missing = REQUIRED_HEADERS.filter((header) => {
      const key = HEADER_KEYS[header];
      return !key || !columns[key];
    });
    if (missing.length)
      throw new BadRequestException(
        `Thiếu cột bắt buộc: ${missing.join(', ')}`,
      );

    const cell = (row: ExcelJS.Row, key: keyof ParsedFactoryRow) => {
      const index = columns[key];
      return index ? this.value(row.getCell(index).value) : '';
    };
    const rows: ParsedFactoryRow[] = [];
    sheet.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return;
      const name = cell(excelRow, 'name');
      const code = cell(excelRow, 'code');
      if (!name && !code) return;
      const errors: string[] = [];
      if (!name) errors.push('Thiếu tên nhà máy');
      rows.push({
        row: rowNumber,
        code: code || undefined,
        name,
        fullName: cell(excelRow, 'fullName') || undefined,
        supplierCode: cell(excelRow, 'supplierCode') || undefined,
        supplierName: cell(excelRow, 'supplierName') || undefined,
        country: cell(excelRow, 'country').toUpperCase() || undefined,
        strategicLevel: this.strategicLevel(
          cell(excelRow, 'strategicLevel'),
          errors,
        ),
        wechat: cell(excelRow, 'wechat') || undefined,
        email: cell(excelRow, 'email') || undefined,
        moq: this.number(cell(excelRow, 'moq'), 'MOQ', errors),
        leadtimeDays: this.number(
          cell(excelRow, 'leadtimeDays'),
          'Leadtime',
          errors,
        ),
        paymentTerm: cell(excelRow, 'paymentTerm') || undefined,
        isActive: this.bool(cell(excelRow, 'isActive'), errors),
        contactNumber: cell(excelRow, 'contactNumber') || undefined,
        address: cell(excelRow, 'address') || undefined,
        currency: cell(excelRow, 'currency').toUpperCase() || undefined,
        description: cell(excelRow, 'description') || undefined,
        errors,
      });
    });
    return rows;
  }

  async preview(file: Express.Multer.File) {
    const rows = await this.parse(file);
    const [factories, suppliers] = await this.prisma.$transaction([
      this.prisma.factory.findMany({
        select: { id: true, code: true, name: true },
      }),
      this.prisma.supplier.findMany({
        select: { id: true, code: true, name: true },
      }),
    ]);
    const byCode = new Map(
      factories
        .filter((factory) => factory.code)
        .map((factory) => [factory.code!, factory]),
    );
    const byName = new Map(
      factories.map((factory) => [factory.name.toLowerCase(), factory]),
    );
    const supplierByCode = new Map(
      suppliers
        .filter((supplier) => supplier.code)
        .map((supplier) => [supplier.code!, supplier]),
    );
    const supplierByName = new Map(
      suppliers.map((supplier) => [supplier.name.toLowerCase(), supplier]),
    );
    const seenCodes = new Set<string>();
    const seenNames = new Set<string>();
    let nextSequence = Number(
      nextFactoryCode(factories.map((factory) => factory.code)).slice(2),
    );

    const result: FactoryImportPreviewRow[] = rows.map((row) => {
      let supplier = row.supplierCode
        ? supplierByCode.get(row.supplierCode)
        : undefined;
      supplier ||= row.supplierName
        ? supplierByName.get(row.supplierName.toLowerCase())
        : undefined;
      if ((row.supplierCode || row.supplierName) && !supplier) {
        row.errors.push(
          `Không tìm thấy NCC ${row.supplierCode || row.supplierName}`,
        );
      }
      const factory = row.code
        ? byCode.get(row.code)
        : byName.get(row.name.toLowerCase());

      // `Factory.name` không unique ở DB nhưng service chặn trùng tên, nên
      // import cũng phải chặn: đổi tên sang tên đã thuộc nhà máy khác là lỗi.
      const nameOwner = byName.get(row.name.toLowerCase());
      if (nameOwner && (!factory || nameOwner.id !== factory.id)) {
        row.errors.push(`Tên nhà máy "${row.name}" đã thuộc nhà máy khác`);
      }

      const identity = row.code || row.name.toLowerCase();
      const seen = row.code ? seenCodes : seenNames;
      if (seen.has(identity)) row.errors.push('Trùng nhà máy trong file');
      seen.add(identity);
      const resolvedCode =
        factory?.code || row.code || formatFactoryCode(nextSequence++);
      return {
        ...row,
        resolvedCode,
        supplier: supplier
          ? { id: supplier.id, code: supplier.code, name: supplier.name }
          : null,
        action: row.errors.length ? 'error' : factory ? 'update' : 'create',
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

  async commit(file: Express.Multer.File, userId: number) {
    const preview = await this.preview(file);
    if (preview.invalid) {
      throw new BadRequestException({
        message: 'File có dòng không hợp lệ, hãy sửa và kiểm tra lại',
        ...preview,
      });
    }
    await this.prisma.$transaction(
      async (tx) => {
        for (const row of preview.rows) {
          const current = row.code
            ? await tx.factory.findUnique({ where: { code: row.code } })
            : await tx.factory.findFirst({ where: { name: row.name } });
          const data = {
            name: row.name,
            ...(row.fullName !== undefined ? { fullName: row.fullName } : {}),
            ...(row.country !== undefined ? { country: row.country } : {}),
            ...(row.strategicLevel !== undefined
              ? { strategicLevel: row.strategicLevel }
              : {}),
            ...(row.wechat !== undefined ? { wechat: row.wechat } : {}),
            ...(row.email !== undefined ? { email: row.email } : {}),
            ...(row.moq !== undefined ? { moq: row.moq } : {}),
            ...(row.leadtimeDays !== undefined
              ? { leadtimeDays: row.leadtimeDays }
              : {}),
            ...(row.paymentTerm !== undefined
              ? { paymentTerm: row.paymentTerm }
              : {}),
            ...(row.isActive !== undefined ? { isActive: row.isActive } : {}),
            ...(row.contactNumber !== undefined
              ? { contactNumber: row.contactNumber }
              : {}),
            ...(row.address !== undefined ? { address: row.address } : {}),
            ...(row.currency !== undefined ? { currency: row.currency } : {}),
            ...(row.description !== undefined
              ? { description: row.description }
              : {}),
            // Chỉ thay đổi NCC khi file có cột NCC; ô trống không làm mất liên kết cũ.
            ...(row.supplierCode || row.supplierName
              ? { supplierId: row.supplier?.id ?? null }
              : {}),
          };
          if (current) {
            await tx.factory.update({ where: { id: current.id }, data });
          } else {
            await tx.factory.create({
              data: { ...data, code: row.resolvedCode, createdBy: userId },
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
    const sheet = workbook.addWorksheet('Factories');
    sheet.columns = [
      { header: 'Mã nhà máy', key: 'code', width: 18 },
      { header: 'Tên nhà máy', key: 'name', width: 30 },
      { header: 'Tên đầy đủ', key: 'fullName', width: 42 },
      { header: 'Mã NCC', key: 'supplierCode', width: 16 },
      { header: 'Tên NCC', key: 'supplierName', width: 26 },
      { header: 'Quốc gia', key: 'country', width: 12 },
      {
        header: 'Mức độ chiến lược (Chiến lược/Ưu tiên/Dự phòng/Thử nghiệm)',
        key: 'strategicLevel',
        width: 46,
      },
      { header: 'Wechat', key: 'wechat', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'MOQ', key: 'moq', width: 12 },
      { header: 'Leadtime', key: 'leadtimeDays', width: 14 },
      { header: 'Payment Term', key: 'paymentTerm', width: 26 },
      { header: 'Status', key: 'isActive', width: 16 },
      { header: 'Số điện thoại', key: 'contactNumber', width: 18 },
      { header: 'Địa chỉ', key: 'address', width: 32 },
      { header: 'Tiền tệ', key: 'currency', width: 12 },
      { header: 'Ghi chú', key: 'description', width: 30 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { horizontal: 'center', wrapText: true };
    sheet.getRow(1).height = 34;
    sheet.addRow({
      code: 'NM0001',
      name: 'Nhà máy mẫu',
      fullName: 'Công ty TNHH Nhà máy mẫu Quốc tế',
      supplierCode: 'NCC001',
      supplierName: 'Nhà cung cấp mẫu',
      country: 'CN',
      strategicLevel: 'Ưu tiên',
      wechat: 'factory-wechat',
      email: 'factory@example.com',
      moq: 100,
      leadtimeDays: 14,
      paymentTerm: 'T/T 30% - 70%',
      isActive: 'Hoạt động',
      currency: 'CNY',
    });
    // Dropdown trong Excel giúp người dùng nhập đúng tiếng Việt; backend vẫn
    // nhận mã tiếng Anh để tương thích file cũ/API. Áp dụng sẵn cho 999 dòng.
    for (let row = 2; row <= 1000; row += 1) {
      sheet.getCell(`G${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Chiến lược,Ưu tiên,Dự phòng,Thử nghiệm"'],
      };
    }
    return workbook.xlsx.writeBuffer();
  }
}
