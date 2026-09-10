import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import {
  CustomerDemandImportGroup,
  CustomerDemandImportParsedRow,
  CustomerDemandImportRawRow,
  groupCustomerDemandImportRows,
  normalizeImportHeader,
  validateImportRow,
} from '../domain/customer-demand-import';
import { CustomerDemandRepository } from '../repositories/customer-demand.repository';

type HeaderKey = keyof CustomerDemandImportRawRow;

const HEADER_KEYS: Record<string, HeaderKey | undefined> = {
  'ma khach hang': 'customerCode',
  'customer code': 'customerCode',
  'ten khach hang': 'customerName',
  'customer name': 'customerName',
  'ma san pham': 'productCode',
  'product code': 'productCode',
  sku: 'productCode',
  'ten san pham': 'productName',
  'product name': 'productName',
  'thang can hang': 'monthRaw',
  thang: 'monthRaw',
  month: 'monthRaw',
  'so luong': 'quantityRaw',
  quantity: 'quantityRaw',
  sl: 'quantityRaw',
  'don vi': 'unitRaw',
  unit: 'unitRaw',
  'ghi chu phieu': 'note',
  'ghi chu': 'note',
  note: 'note',
};

const REQUIRED_HEADERS: HeaderKey[] = [
  'customerCode',
  'productCode',
  'monthRaw',
  'quantityRaw',
];

export interface CustomerDemandImportPreviewRow
  extends CustomerDemandImportParsedRow {
  customer: { id: number; code: string | null; name: string } | null;
  product: {
    id: number;
    code: string;
    name: string;
    unit: string | null;
    conversionValue: number;
  } | null;
  quantityBase: number | null;
}

export interface CustomerDemandImportPreview {
  total: number;
  valid: number;
  invalid: number;
  vouchers: number;
  months: number;
  rows: CustomerDemandImportPreviewRow[];
  groups: CustomerDemandImportGroup[];
}

@Injectable()
export class CustomerDemandImportService {
  constructor(
    private readonly repository: CustomerDemandRepository,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async template() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Demand');
    sheet.columns = [
      { header: 'Mã khách hàng', key: 'customerCode', width: 18 },
      { header: 'Tên khách hàng', key: 'customerName', width: 28 },
      { header: 'Mã sản phẩm', key: 'productCode', width: 18 },
      { header: 'Tên sản phẩm', key: 'productName', width: 32 },
      { header: 'Tháng cần hàng', key: 'monthRaw', width: 16 },
      { header: 'Số lượng', key: 'quantityRaw', width: 14 },
      { header: 'Đơn vị', key: 'unitRaw', width: 18 },
      { header: 'Ghi chú phiếu', key: 'note', width: 28 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { wrapText: true, horizontal: 'center' };
    sheet.addRow({
      customerCode: 'KH001',
      customerName: 'Khách OEM mẫu',
      productCode: 'SP001',
      productName: 'Nguyên liệu mẫu',
      monthRaw: '2026-10',
      quantityRaw: 100,
      unitRaw: 'Đơn vị cơ bản',
      note: 'Demand OEM tháng 10',
    });
    sheet.addRow({
      customerCode: 'KH001',
      customerName: 'Khách OEM mẫu',
      productCode: 'SP002',
      productName: 'Nguyên liệu mẫu 2',
      monthRaw: '2026-10',
      quantityRaw: 5,
      unitRaw: 'Thùng',
      note: 'Demand OEM tháng 10',
    });
    for (let row = 2; row <= 1000; row += 1) {
      sheet.getCell(`G${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Đơn vị cơ bản,Thùng"'],
      };
    }

    const guide = workbook.addWorksheet('HuongDan');
    guide.columns = [{ header: 'Hướng dẫn import Demand khách hàng', width: 110 }];
    guide.addRows([
      ['Mỗi dòng là 1 sản phẩm của 1 khách hàng trong 1 tháng cần hàng.'],
      ['Bắt buộc: Mã khách hàng, Mã sản phẩm, Tháng cần hàng (YYYY-MM), Số lượng.'],
      ['Đơn vị để trống hoặc "Đơn vị cơ bản" = số lượng theo đơn vị sản phẩm; "Thùng" sẽ nhân conversionValue.'],
      ['Nhiều dòng cùng mã khách hàng được gom vào phiếu nháp sớm nhất còn trống cặp sản phẩm/tháng.'],
      ['Trùng cùng sản phẩm trong cùng tháng của cùng khách sẽ tách sang phiếu nháp mới, không báo lỗi trùng.'],
      ['Import chỉ tạo phiếu nháp. Cần duyệt từng tháng trước khi cộng vào dự kiến đặt hàng.'],
      ['Demand import không tạo Order, hóa đơn, công nợ hoặc giữ tồn.'],
    ]);
    return workbook.xlsx.writeBuffer();
  }

  async preview(file: Express.Multer.File): Promise<CustomerDemandImportPreview> {
    const rawRows = await this.parse(file);
    if (!rawRows.length) {
      throw new BadRequestException('File Excel không có dòng dữ liệu');
    }

    const parsed = rawRows.map((row) => validateImportRow(row));
    const customerCodes = [
      ...new Set(parsed.map((row) => row.customerCode).filter(Boolean)),
    ];
    const productCodes = [
      ...new Set(parsed.map((row) => row.productCode).filter(Boolean)),
    ];
    const [customers, products] = await Promise.all([
      this.repository.findCustomersByCodes(customerCodes),
      this.repository.findProductsByCodes(productCodes),
    ]);
    const customerMap = new Map(
      customers
        .filter((item) => item.code)
        .map((item) => [item.code!.toLowerCase(), item]),
    );
    const productMap = new Map(
      products.map((item) => [item.code.toLowerCase(), item]),
    );

    const rows: CustomerDemandImportPreviewRow[] = parsed.map((row) => {
      const customer = row.customerCode
        ? (customerMap.get(row.customerCode.toLowerCase()) ?? null)
        : null;
      const product = row.productCode
        ? (productMap.get(row.productCode.toLowerCase()) ?? null)
        : null;
      const errors = [...row.errors];
      if (row.customerCode && !customer) {
        errors.push(`Không tìm thấy khách hàng mã ${row.customerCode}`);
      } else if (customer && customer.isActive === false) {
        errors.push(`Khách hàng ${row.customerCode} đang ngừng hoạt động`);
      }
      if (row.productCode && !product) {
        errors.push(`Không tìm thấy sản phẩm mã ${row.productCode}`);
      } else if (product && product.isActive === false) {
        errors.push(`Sản phẩm ${row.productCode} đang ngừng hoạt động`);
      }

      let quantityBase: number | null = null;
      let conversionValue: number | null = null;
      if (product && row.quantity != null && row.quantity > 0) {
        conversionValue =
          row.unit === 'CARTON' ? Number(product.conversionValue) : 1;
        if (
          row.unit === 'CARTON' &&
          (!Number.isFinite(conversionValue) || conversionValue <= 0)
        ) {
          errors.push(`Sản phẩm ${product.code} thiếu quy đổi thùng`);
        } else {
          quantityBase = row.quantity * (conversionValue ?? 1);
        }
      }

      return {
        ...row,
        errors,
        customer: customer
          ? { id: customer.id, code: customer.code, name: customer.name }
          : null,
        product: product
          ? {
              id: product.id,
              code: product.code,
              name: product.name,
              unit: product.unit,
              conversionValue: Number(product.conversionValue),
            }
          : null,
        quantityBase,
      };
    });

    const groupedRows = rows.map((row) => ({
      ...row,
      customerId: row.customer?.id,
      customerNameResolved: row.customer?.name,
      productId: row.product?.id,
      productNameResolved: row.product?.name,
      quantityBase: row.quantityBase,
      conversionValue:
        row.unit === 'CARTON'
          ? row.product?.conversionValue ?? null
          : row.quantityBase != null
            ? 1
            : null,
    }));
    const groups = groupCustomerDemandImportRows(groupedRows);
    groupedRows.forEach((grouped, index) => {
      rows[index].voucherIndex = grouped.voucherIndex;
    });

    const invalid = rows.filter((row) => row.errors.length).length;
    return {
      total: rows.length,
      valid: rows.length - invalid,
      invalid,
      vouchers: groups.length,
      months: groups.reduce((sum, group) => sum + group.months.length, 0),
      rows,
      groups,
    };
  }

  async commit(file: Express.Multer.File, userId: number) {
    const preview = await this.preview(file);
    if (preview.invalid > 0) {
      throw new BadRequestException(
        'File còn dòng lỗi nên chưa import được. Sửa file rồi tải lại.',
      );
    }
    if (!preview.groups.length) {
      throw new BadRequestException('Không có dòng hợp lệ để import');
    }

    const ids = await this.repository.createManyDrafts(
      preview.groups.map((group) => ({
        customerId: group.customerId,
        note: group.note ?? null,
        createdBy: userId,
        months: group.months.map((month) => ({
          demandMonth: new Date(`${month.month}-01T00:00:00.000Z`),
          lines: month.lines.map((line) => ({
            productId: line.productId,
            inputQuantity: line.quantity,
            inputUnit: line.unit,
            quantityBase: line.quantityBase,
            conversionValue: line.conversionValue,
          })),
        })),
      })),
    );

    await this.auditLogs.create({
      actionType: 'CREATE',
      actionCode: 'CUSTOMER_DEMAND_IMPORT',
      entityType: 'CUSTOMER_DEMAND',
      entityId: ids.join(','),
      message: `Đã import ${ids.length} phiếu Demand khách hàng từ Excel`,
      userId,
      userName: 'System',
      snapshot: {
        ids,
        total: preview.total,
        vouchers: preview.vouchers,
        months: preview.months,
      },
    });

    return {
      total: preview.total,
      imported: preview.valid,
      vouchers: ids.length,
      months: preview.months,
      ids,
    };
  }

  private async parse(
    file: Express.Multer.File,
  ): Promise<CustomerDemandImportRawRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet =
      workbook.getWorksheet('Demand') ||
      workbook.worksheets.find((item) => item.name !== 'HuongDan') ||
      workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống');

    const columns: Partial<Record<HeaderKey, number>> = {};
    sheet.getRow(1).eachCell((cell, index) => {
      const key = HEADER_KEYS[normalizeImportHeader(this.value(cell.value))];
      if (key) columns[key] = index;
    });
    const missing = REQUIRED_HEADERS.filter((header) => !columns[header]);
    if (missing.length) {
      throw new BadRequestException(
        'Thiếu cột bắt buộc: Mã khách hàng, Mã sản phẩm, Tháng cần hàng, Số lượng',
      );
    }

    const rows: CustomerDemandImportRawRow[] = [];
    sheet.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return;
      const customerCode = this.cell(excelRow, columns.customerCode);
      const productCode = this.cell(excelRow, columns.productCode);
      const monthRaw = this.monthCell(excelRow, columns.monthRaw);
      const quantityRaw = this.cell(excelRow, columns.quantityRaw);
      const unitRaw = this.cell(excelRow, columns.unitRaw);
      const customerName = this.cell(excelRow, columns.customerName);
      const productName = this.cell(excelRow, columns.productName);
      const note = this.cell(excelRow, columns.note);
      if (
        !customerCode &&
        !productCode &&
        !monthRaw &&
        !quantityRaw &&
        !unitRaw &&
        !note
      ) {
        return;
      }
      rows.push({
        row: rowNumber,
        customerCode,
        customerName,
        productCode,
        productName,
        monthRaw,
        quantityRaw,
        unitRaw,
        note,
      });
    });
    return rows;
  }

  private cell(row: ExcelJS.Row, index?: number) {
    if (!index) return '';
    return this.value(row.getCell(index).value);
  }

  private monthCell(row: ExcelJS.Row, index?: number) {
    if (!index) return '';
    const value = row.getCell(index).value;
    if (value instanceof Date) {
      const local = new Date(
        value.getTime() - value.getTimezoneOffset() * 60_000,
      );
      return local.toISOString().slice(0, 7);
    }
    return this.value(value);
  }

  private value(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) {
      const local = new Date(
        value.getTime() - value.getTimezoneOffset() * 60_000,
      );
      return local.toISOString().slice(0, 10);
    }
    if (typeof value === 'object') {
      const cell = value as {
        text?: unknown;
        result?: unknown;
        richText?: Array<{ text?: unknown }>;
      };
      if (Array.isArray(cell.richText)) {
        return cell.richText.map((part) => this.value(part.text)).join('').trim();
      }
      if (cell.text !== undefined) return this.value(cell.text);
      if (cell.result !== undefined) return this.value(cell.result);
    }
    return '';
  }
}
