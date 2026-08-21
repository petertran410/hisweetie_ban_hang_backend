import { Injectable, BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEBT_FORM,
  MIN_PAYMENT_RATIO_WARN,
} from './debt-tracking.constants';

// ====================================================================
// IMPORT THIẾT LẬP CÔNG NỢ TỪ EXCEL
//
// Nguồn dữ liệu là file quản lý công nợ đang dùng ngoài thực tế. Mục tiêu:
// thiết lập hàng loạt thay vì bấm tay từng khách.
//
// NGUYÊN TẮC AN TOÀN:
//   - Hai bước: preview (chỉ đọc) → commit (ghi). Còn dòng lỗi ⇒ TỪ CHỐI
//     TOÀN BỘ, không ghi một phần.
//   - CHỈ ghi vào bảng customer_debt_policies. Không đụng tới công nợ
//     (customers.totalDebt), sổ quỹ (cash_flows) hay hóa đơn (invoices).
//   - Mỗi dòng = MỘT mã khách. Ô mã chứa nhiều mã ⇒ báo lỗi để người dùng
//     tự tách trong Excel; hệ thống không tự đoán áp cho mã nào.
// ====================================================================

/** Tên cột chấp nhận (đã lowercase, bỏ dấu cách thừa). */
const HEADER_ALIASES: Record<string, keyof ParsedPolicyRow> = {
  'mã khách hàng': 'code',
  'mã khách': 'code',
  'mã kh': 'code',
  'mã khách (text)': 'code',
  'hình thức công nợ': 'debtForm',
  'loại công nợ': 'debtType',
  'hạn mức công nợ': 'creditLimit',
};

const REQUIRED_HEADERS = ['mã khách hàng', 'loại công nợ'];

/** Chuỗi trong Excel → enum hình thức công nợ. */
const DEBT_FORM_MAP: Record<string, string> = {
  'công nợ tín nhiệm': DEBT_FORM.TRUST,
  'hợp đồng công nợ': DEBT_FORM.CONTRACT,
  'thanh toán khi nhận hàng': DEBT_FORM.COD,
  'chuyển khoản ngay': DEBT_FORM.PREPAID,
};

export interface ParsedPolicyRow {
  row: number;
  code: string;
  debtForm: string;
  debtType: string;
  creditLimit: string;

  // Kết quả sau khi phân tích
  hasCreditLimit: boolean;
  hasTermDays: boolean;
  termDays: number | null;
  paymentFrequency: number | null;
  creditLimitValue: number | null;
  debtFormValue: string | null;

  errors: string[];
  warnings: string[];
}

export interface PolicyImportPreviewRow extends ParsedPolicyRow {
  customerId: number | null;
  customerName: string | null;
  action: 'create' | 'update' | 'error';
}

@Injectable()
export class DebtPolicyImportService {
  constructor(private prisma: PrismaService) {}

  // ---------------------------------------------------------- helpers

  private value(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      // ExcelJS trả object cho ô công thức / rich text.
      const anyV = v as Record<string, unknown>;
      if ('result' in anyV) return this.value(anyV.result);
      if ('text' in anyV) return this.value(anyV.text);
      if ('richText' in anyV && Array.isArray(anyV.richText)) {
        return (anyV.richText as Array<{ text?: string }>)
          .map((t) => t.text ?? '')
          .join('');
      }
    }
    return String(v).trim();
  }

  /** Đọc số tiền: bỏ dấu phân cách nghìn, chấp nhận ô trống. */
  private money(raw: string): number | null {
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d.-]/g, '');
    if (!cleaned || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Phân tích cột "Loại Công Nợ" thành HAI CHIỀU độc lập.
   * Đây là multi-select trong file gốc, ví dụ "Hạn Mức, Công Nợ 7 Ngày".
   */
  parseDebtType(raw: string): {
    hasCreditLimit: boolean;
    hasTermDays: boolean;
    termDays: number | null;
    paymentFrequency: number | null;
    recognized: boolean;
  } {
    const s = (raw || '').toLowerCase().trim();

    const empty = {
      hasCreditLimit: false,
      hasTermDays: false,
      termDays: null,
      paymentFrequency: null,
    };

    if (!s) return { ...empty, recognized: false };

    // "Không Công Nợ" là giá trị hợp lệ: tắt cả hai chiều.
    if (s.includes('không công nợ')) return { ...empty, recognized: true };

    const hasCreditLimit = s.includes('hạn mức');

    // "Công Nợ 55 Ngày" → 55
    const mDays = s.match(/(\d+)\s*ngày/);
    const termDays = mDays ? parseInt(mDays[1], 10) : null;

    // "1 Tháng 2 Lần" → 2 lần/tháng
    const mFreq = s.match(/(\d+)\s*lần/);
    const paymentFrequency = mFreq ? parseInt(mFreq[1], 10) : null;

    const recognized =
      hasCreditLimit || termDays !== null || paymentFrequency !== null;

    return {
      hasCreditLimit,
      hasTermDays: termDays !== null,
      termDays,
      paymentFrequency,
      recognized,
    };
  }

  private mapEnum(
    raw: string,
    map: Record<string, string>,
  ): { value: string | null; unknown: boolean } {
    const s = (raw || '').toLowerCase().trim();
    if (!s) return { value: null, unknown: false };
    const v = map[s];
    return v ? { value: v, unknown: false } : { value: null, unknown: true };
  }

  // ------------------------------------------------------------ parse

  private async parse(
    file: Express.Multer.File,
  ): Promise<ParsedPolicyRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống');

    // Dò vị trí cột theo tên tiêu đề ở dòng 1.
    const columns: Partial<Record<keyof ParsedPolicyRow, number>> = {};
    const seenHeaders = new Set<string>();
    sheet.getRow(1).eachCell((cell, index) => {
      const header = this.value(cell.value).toLowerCase();
      seenHeaders.add(header);
      const key = HEADER_ALIASES[header];
      // Giữ cột đầu tiên khớp — file gốc có cả "Mã Khách Hàng" và
      // "Mã Khách (Text)" trùng nội dung.
      if (key && !columns[key]) columns[key] = index;
    });

    const missing = REQUIRED_HEADERS.filter((h) => !seenHeaders.has(h));
    if (missing.length) {
      throw new BadRequestException(
        `Thiếu cột bắt buộc: ${missing.join(', ')}`,
      );
    }

    const cellOf = (row: ExcelJS.Row, key: keyof ParsedPolicyRow) => {
      const idx = columns[key];
      return idx ? this.value(row.getCell(idx).value) : '';
    };

    const rows: ParsedPolicyRow[] = [];

    sheet.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return;

      const code = cellOf(excelRow, 'code');
      const debtType = cellOf(excelRow, 'debtType');
      // Dòng trống hoàn toàn → bỏ qua, không tính là lỗi.
      if (!code && !debtType) return;

      const errors: string[] = [];
      const warnings: string[] = [];

      if (!code) errors.push('Thiếu mã khách hàng');

      // Mỗi dòng chỉ được có MỘT mã. Nhiều mã trong một ô thì không thể
      // biết chính sách áp cho mã nào ⇒ yêu cầu người dùng tự tách.
      if (code && /[,;]/.test(code)) {
        const parts = code
          .split(/[,;]/)
          .map((p) => p.trim())
          .filter(Boolean);
        errors.push(
          `Ô mã khách chứa ${parts.length} mã. Mỗi dòng chỉ được 1 mã — ` +
            `hãy tách thành ${parts.length} dòng riêng rồi import lại.`,
        );
      }

      const parsed = this.parseDebtType(debtType);
      if (!parsed.recognized) {
        errors.push(
          `Không hiểu "Loại Công Nợ": "${debtType}". ` +
            `Chấp nhận: "Không Công Nợ", "Hạn Mức", "Công Nợ N Ngày", ` +
            `"1 Tháng N Lần" hoặc kết hợp.`,
        );
      }

      const creditLimitRaw = cellOf(excelRow, 'creditLimit');
      const creditLimitValue = this.money(creditLimitRaw);

      // Bật hạn mức mà không có giá trị: cho qua nhưng cảnh báo, vì chiều
      // hạn mức sẽ không cảnh báo được gì cho tới khi bổ sung số.
      if (
        parsed.hasCreditLimit &&
        (creditLimitValue === null || creditLimitValue <= 0)
      ) {
        warnings.push(
          'Có "Hạn Mức" nhưng chưa nhập giá trị — cần bổ sung sau để chiều hạn mức hoạt động',
        );
      }

      if (parsed.termDays !== null && parsed.termDays > 3650) {
        errors.push(`Số ngày công nợ không hợp lệ: ${parsed.termDays}`);
      }

      const df = this.mapEnum(cellOf(excelRow, 'debtForm'), DEBT_FORM_MAP);
      if (df.unknown) {
        warnings.push(
          `Không hiểu "Hình Thức Công Nợ": "${cellOf(excelRow, 'debtForm')}" — bỏ qua cột này`,
        );
      }



      rows.push({
        row: rowNumber,
        code,
        debtForm: cellOf(excelRow, 'debtForm'),
        debtType,
        creditLimit: creditLimitRaw,

        hasCreditLimit: parsed.hasCreditLimit,
        hasTermDays: parsed.hasTermDays,
        termDays: parsed.termDays,
        paymentFrequency: parsed.paymentFrequency,
        creditLimitValue: parsed.hasCreditLimit ? creditLimitValue : null,
        debtFormValue: df.value,

        errors,
        warnings,
      });
    });

    if (rows.length === 0) {
      throw new BadRequestException('File không có dòng dữ liệu nào');
    }

    return rows;
  }

  // ---------------------------------------------------------- preview

  /** Bước 1: đọc file, đối chiếu DB. KHÔNG ghi gì. */
  async preview(file: Express.Multer.File) {
    const rows = await this.parse(file);

    // Chỉ tra những mã sạch (không chứa dấu phẩy) để tránh query rác.
    const codes = [
      ...new Set(
        rows
          .map((r) => r.code)
          .filter((c) => c && !/[,;]/.test(c)),
      ),
    ];

    const customers = codes.length
      ? await this.prisma.customer.findMany({
          where: { code: { in: codes } },
          select: { id: true, code: true, name: true },
        })
      : [];

    const byCode = new Map(
      customers.filter((c) => c.code).map((c) => [c.code as string, c]),
    );

    const existing = customers.length
      ? await this.prisma.customerDebtPolicy.findMany({
          where: { customerId: { in: customers.map((c) => c.id) } },
          select: { customerId: true },
        })
      : [];
    const hasPolicy = new Set(existing.map((e) => e.customerId));

    const seen = new Map<string, number>();

    const result: PolicyImportPreviewRow[] = rows.map((row) => {
      const customer = row.code ? byCode.get(row.code) : undefined;

      if (row.code && !/[,;]/.test(row.code) && !customer) {
        row.errors.push(`Mã khách "${row.code}" không tồn tại trong hệ thống`);
      }

      // Trùng mã giữa các dòng: không biết dòng nào thắng ⇒ báo lỗi.
      if (row.code) {
        const firstRow = seen.get(row.code);
        if (firstRow !== undefined) {
          row.errors.push(
            `Mã "${row.code}" đã xuất hiện ở dòng ${firstRow} — mỗi mã chỉ được 1 dòng`,
          );
        } else {
          seen.set(row.code, row.row);
        }
      }

      return {
        ...row,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        action: row.errors.length
          ? 'error'
          : customer && hasPolicy.has(customer.id)
            ? 'update'
            : 'create',
      };
    });

    const invalidRows = result.filter((r) => r.errors.length);

    return {
      total: result.length,
      valid: result.length - invalidRows.length,
      invalid: invalidRows.length,
      create: result.filter((r) => r.action === 'create').length,
      update: result.filter((r) => r.action === 'update').length,
      warningCount: result.filter((r) => r.warnings.length).length,
      canCommit: invalidRows.length === 0,
      rows: result,
    };
  }

  // ----------------------------------------------------------- commit

  /**
   * Bước 2: ghi DB. Từ chối TOÀN BỘ nếu còn dòng lỗi — không ghi một phần
   * để tránh tình trạng nửa vời khó lần lại.
   */
  async commit(file: Express.Multer.File, userId: number) {
    const preview = await this.preview(file);

    if (preview.invalid > 0) {
      throw new BadRequestException({
        message: `File còn ${preview.invalid} dòng lỗi. Vui lòng sửa trong Excel rồi import lại.`,
        total: preview.total,
        valid: preview.valid,
        invalid: preview.invalid,
        rows: preview.rows.filter((r) => r.errors.length),
      });
    }

    let created = 0;
    let updated = 0;

    await this.prisma.$transaction(
      async (tx) => {
        for (const row of preview.rows) {
          if (!row.customerId) continue;

          const data = {
            hasCreditLimit: row.hasCreditLimit,
            creditLimit: row.hasCreditLimit ? row.creditLimitValue : null,
            hasTermDays: row.hasTermDays,
            termDays: row.hasTermDays ? row.termDays : null,
            paymentFrequency: row.paymentFrequency,
            debtForm: row.debtFormValue,
            isActive: true,
          };

          if (row.action === 'update') updated++;
          else created++;

          await tx.customerDebtPolicy.upsert({
            where: { customerId: row.customerId },
            create: {
              customerId: row.customerId,
              ...data,
              createdBy: userId,
              updatedBy: userId,
            },
            update: { ...data, updatedBy: userId },
          });
        }
      },
      { timeout: 120000 },
    );

    return {
      message: `Import thành công: tạo mới ${created}, cập nhật ${updated}`,
      total: preview.total,
      created,
      updated,
      warningCount: preview.warningCount,
      warnings: preview.rows
        .filter((r) => r.warnings.length)
        .map((r) => ({ row: r.row, code: r.code, warnings: r.warnings })),
    };
  }

  // --------------------------------------------------------- template

  /** File mẫu kèm dòng ví dụ và sheet hướng dẫn. */
  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Thiết lập công nợ');

    ws.columns = [
      { header: 'Mã Khách Hàng', key: 'code', width: 20 },
      { header: 'Hình Thức Công Nợ', key: 'debtForm', width: 24 },
      { header: 'Loại Công Nợ', key: 'debtType', width: 26 },
      { header: 'Hạn Mức Công Nợ', key: 'creditLimit', width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('creditLimit').numFmt = '#,##0';

    ws.addRows([
      {
        code: 'KH000001',
        debtForm: 'Công Nợ Tín Nhiệm',
        debtType: 'Công Nợ 30 Ngày',
        creditLimit: '',
      },
      {
        code: 'KH000002',
        debtForm: 'Hợp Đồng Công Nợ',
        debtType: 'Hạn Mức, Công Nợ 7 Ngày',
        creditLimit: 500000000,
      },
      {
        code: 'KH000003',
        debtForm: 'Thanh Toán Khi Nhận Hàng',
        debtType: 'Không Công Nợ',
        creditLimit: '',
      },
    ]);

    const guide = wb.addWorksheet('Hướng dẫn');
    guide.columns = [
      { header: 'Cột', key: 'col', width: 24 },
      { header: 'Bắt buộc', key: 'req', width: 10 },
      { header: 'Giá trị chấp nhận', key: 'val', width: 70 },
    ];
    guide.getRow(1).font = { bold: true };

    guide.addRows([
      {
        col: 'Mã Khách Hàng',
        req: 'Có',
        val: 'Đúng 1 mã mỗi dòng. Nhiều mã trong một ô sẽ báo lỗi — hãy tách thành nhiều dòng.',
      },
      {
        col: 'Hình Thức Công Nợ',
        req: 'Không',
        val: 'Công Nợ Tín Nhiệm | Hợp Đồng Công Nợ | Thanh Toán Khi Nhận Hàng | Chuyển Khoản Ngay',
      },
      {
        col: 'Loại Công Nợ',
        req: 'Có',
        val: 'Không Công Nợ | Hạn Mức | Công Nợ N Ngày | 1 Tháng N Lần. Kết hợp bằng dấu phẩy, VD: "Hạn Mức, Công Nợ 7 Ngày"',
      },
      {
        col: 'Hạn Mức Công Nợ',
        req: 'Không',
        val: 'Số tiền (VND). Bắt buộc điền nếu Loại Công Nợ có "Hạn Mức", nếu không sẽ bị cảnh báo.',
      },
      { col: '', req: '', val: '' },
      {
        col: 'GHI CHÚ',
        req: '',
        val: 'Bật cả "Hạn Mức" và "Công Nợ N Ngày" thì khách chỉ bị tính quá hạn khi thỏa ĐỒNG THỜI cả hai điều kiện.',
      },
      {
        col: '',
        req: '',
        val: '"1 Tháng N Lần" chỉ dùng để đếm số lần đã trả trong tháng, KHÔNG sinh hạn thanh toán.',
      },
      {
        col: '',
        req: '',
        val: 'Khách đã có thiết lập sẽ bị GHI ĐÈ. Import chỉ ghi vào thiết lập công nợ, không đụng tới số nợ hay sổ quỹ.',
      },
      {
        col: '',
        req: '',
        val: `Số tiền tối thiểu khi thu hồi nợ không nên thấp hơn ${MIN_PAYMENT_RATIO_WARN * 100}% tổng nợ.`,
      },
    ]);

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
