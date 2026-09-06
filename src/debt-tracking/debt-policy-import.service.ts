import { Injectable, BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEBT_FORM,
  DEBT_RULE_TYPE,
  MIN_PAYMENT_RATIO_WARN,
  PAYMENT_SCHEDULE_TYPE,
  type DebtRuleType,
  type PaymentScheduleType,
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
  'ngày thanh toán': 'paymentSchedule',
  'lịch thanh toán': 'paymentSchedule',
};

const REQUIRED_COLUMNS: Array<keyof ParsedPolicyRow> = ['code', 'debtType'];

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
  paymentSchedule: string;

  // Kết quả sau khi phân tích
  debtRuleType: DebtRuleType | null;
  hasCreditLimit: boolean;
  hasTermDays: boolean;
  termDays: number | null;
  paymentScheduleType: PaymentScheduleType | null;
  paymentScheduleDays: number[] | null;
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

interface ParsedDebtType {
  debtRuleType: DebtRuleType | null;
  hasCreditLimit: boolean;
  hasTermDays: boolean;
  termDays: number | null;
  paymentScheduleType: PaymentScheduleType | null;
  paymentFrequency: number | null;
  recognized: boolean;
}

interface ParsedSchedule {
  days: number[] | null;
  error: string | null;
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
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Phân tích cột "Loại Công Nợ". Từ contract mới, một dòng chỉ được có
   * đúng một quy tắc; các giá trị multi-select cũ như "Hạn Mức, Công Nợ 7
   * Ngày" phải bị từ chối.
   */
  parseDebtType(raw: string): ParsedDebtType {
    const s = this.normalizeText(raw);

    const empty = {
      debtRuleType: null,
      hasCreditLimit: false,
      hasTermDays: false,
      termDays: null,
      paymentScheduleType: null,
      paymentFrequency: null,
    };

    if (!s) return { ...empty, recognized: false };

    if (s === 'không công nợ') {
      return {
        ...empty,
        debtRuleType: DEBT_RULE_TYPE.NONE,
        recognized: true,
      };
    }

    if (s === 'hạn mức') {
      return {
        ...empty,
        debtRuleType: DEBT_RULE_TYPE.CREDIT_LIMIT,
        hasCreditLimit: true,
        recognized: true,
      };
    }

    const mDays = s.match(/^công nợ\s+(\d+)\s+ngày$/);
    if (mDays) {
      const termDays = parseInt(mDays[1], 10);
      return {
        ...empty,
        debtRuleType: DEBT_RULE_TYPE.TERM_DAYS,
        hasTermDays: true,
        termDays,
        recognized: true,
      };
    }

    if (s === 'thanh toán cố định tháng') {
      return {
        ...empty,
        debtRuleType: DEBT_RULE_TYPE.MONTHLY_SCHEDULE,
        paymentScheduleType: PAYMENT_SCHEDULE_TYPE.MONTHLY,
        recognized: true,
      };
    }

    if (s === 'thanh toán cố định tuần') {
      return {
        ...empty,
        debtRuleType: DEBT_RULE_TYPE.WEEKLY_SCHEDULE,
        paymentScheduleType: PAYMENT_SCHEDULE_TYPE.WEEKLY,
        recognized: true,
      };
    }

    return { ...empty, recognized: false };
  }

  /** Phân tích và kiểm tra ngày thanh toán theo đúng miền của lịch. */
  parsePaymentSchedule(
    raw: string,
    scheduleType: PaymentScheduleType,
  ): ParsedSchedule {
    const input = this.normalizeText(raw);
    if (!input) {
      return { days: null, error: 'Thiếu ngày thanh toán cho lịch cố định' };
    }

    const tokens = input
      .split(/[,;|/\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const days: number[] = [];

    for (const token of tokens) {
      let day: number | null = null;

      if (scheduleType === PAYMENT_SCHEDULE_TYPE.MONTHLY) {
        if (/^\d+$/.test(token)) day = Number(token);
      } else {
        const weekday = token.replace(/\s+/g, ' ');
        const match = weekday.match(/^thứ\s*([2-7])$/);
        // ISO weekday numbering: Monday=1 ... Sunday=7.
        if (match) day = Number(match[1]) - 1;
        else if (weekday === 'chủ nhật') day = 7;
      }

      if (day === null) {
        return {
          days: null,
          error: `Ngày thanh toán không hợp lệ: "${token}"`,
        };
      }

      const max = scheduleType === PAYMENT_SCHEDULE_TYPE.MONTHLY ? 31 : 7;
      if (day < 1 || day > max) {
        return {
          days: null,
          error:
            scheduleType === PAYMENT_SCHEDULE_TYPE.MONTHLY
              ? `Ngày thanh toán tháng phải trong khoảng 1-31: ${day}`
              : `Ngày thanh toán tuần phải trong khoảng 1-7: ${day}`,
        };
      }

      if (days.includes(day)) {
        return {
          days: null,
          error: `Ngày thanh toán bị lặp: ${day}`,
        };
      }

      days.push(day);
    }

    const sorted = [...days].sort((a, b) => a - b);
    if (days.some((day, index) => day !== sorted[index])) {
      return {
        days: null,
        error: 'Ngày thanh toán phải được sắp xếp tăng dần và không trùng nhau',
      };
    }

    return { days: sorted, error: null };
  }

  private normalizeText(raw: string): string {
    return (raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  private async parse(file: Express.Multer.File): Promise<ParsedPolicyRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống');

    // Dò vị trí cột theo tên tiêu đề ở dòng 1.
    const columns: Partial<Record<keyof ParsedPolicyRow, number>> = {};
    const seenHeaders = new Set<string>();
    sheet.getRow(1).eachCell((cell, index) => {
      const header = this.normalizeText(this.value(cell.value));
      seenHeaders.add(header);
      const key = HEADER_ALIASES[header];
      // Giữ cột đầu tiên khớp — file gốc có cả "Mã Khách Hàng" và
      // "Mã Khách (Text)" trùng nội dung.
      if (key && !columns[key]) columns[key] = index;
    });

    const missing = REQUIRED_COLUMNS.filter((key) => !columns[key]);
    if (missing.length) {
      const labels = missing.map((key) =>
        key === 'code' ? 'mã khách hàng' : 'loại công nợ',
      );
      throw new BadRequestException(
        `Thiếu cột bắt buộc: ${labels.join(', ')}`,
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
      const paymentSchedule = cellOf(excelRow, 'paymentSchedule');
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
            `Chỉ chọn đúng một: "Không Công Nợ", "Hạn Mức", "Công Nợ N Ngày", ` +
            `"Thanh Toán Cố Định Tháng" hoặc "Thanh Toán Cố Định Tuần". ` +
            `Không được kết hợp nhiều quy tắc.`,
        );
      }

      let paymentScheduleDays: number[] | null = null;
      if (parsed.paymentScheduleType) {
        const schedule = this.parsePaymentSchedule(
          paymentSchedule,
          parsed.paymentScheduleType,
        );
        if (schedule.error) errors.push(schedule.error);
        else paymentScheduleDays = schedule.days;
      }

      const creditLimitRaw = cellOf(excelRow, 'creditLimit');
      const creditLimitValue = this.money(creditLimitRaw);

      if (parsed.hasCreditLimit && creditLimitValue === null) {
        errors.push(
          'Có "Hạn Mức" thì Hạn Mức Công Nợ phải là số tiền lớn hơn 0',
        );
      }

      if (
        parsed.termDays !== null &&
        (parsed.termDays < 1 || parsed.termDays > 3650)
      ) {
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
        paymentSchedule,

        debtRuleType: parsed.debtRuleType,
        hasCreditLimit: parsed.hasCreditLimit,
        hasTermDays: parsed.hasTermDays,
        termDays: parsed.termDays,
        paymentScheduleType: parsed.paymentScheduleType,
        paymentScheduleDays,
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
      ...new Set(rows.map((r) => r.code).filter((c) => c && !/[,;]/.test(c))),
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
            // Legacy flags remain populated for the current readers. The main
            // debt service is responsible for normalizing them to the rule.
            debtRuleType: row.debtRuleType,
            paymentScheduleType: row.paymentScheduleType,
            paymentScheduleDays: row.paymentScheduleDays,
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

          // The deployed Prisma client may predate the new policy columns.
          // Keep this import boundary compatible until the schema is updated.
          const policyModel = tx.customerDebtPolicy as unknown as {
            upsert(args: unknown): Promise<unknown>;
          };
          await policyModel.upsert({
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
      { header: 'Ngày Thanh Toán', key: 'paymentSchedule', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn('creditLimit').numFmt = '#,##0';

    ws.addRows([
      {
        code: 'KH000001',
        debtForm: 'Công Nợ Tín Nhiệm',
        debtType: 'Công Nợ 30 Ngày',
        creditLimit: '',
        paymentSchedule: '',
      },
      {
        code: 'KH000002',
        debtForm: 'Hợp Đồng Công Nợ',
        debtType: 'Hạn Mức',
        creditLimit: 500000000,
        paymentSchedule: '',
      },
      {
        code: 'KH000003',
        debtForm: 'Thanh Toán Khi Nhận Hàng',
        debtType: 'Không Công Nợ',
        creditLimit: '',
        paymentSchedule: '',
      },
      {
        code: 'KH000004',
        debtForm: 'Công Nợ Tín Nhiệm',
        debtType: 'Thanh Toán Cố Định Tuần',
        creditLimit: '',
        paymentSchedule: 'Thứ 2, Thứ 5, Chủ nhật',
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
        val: 'Công Nợ Tín Nhiệm | Hợp Đồng Công Nợ | Thanh Toán Khi Nhận Hàng | Chuyển khoản ngay',
      },
      {
        col: 'Loại Công Nợ',
        req: 'Có',
        val: 'Chỉ một giá trị: Không Công Nợ | Hạn Mức | Công Nợ N Ngày | Thanh Toán Cố Định Tháng | Thanh Toán Cố Định Tuần. Không được kết hợp bằng dấu phẩy.',
      },
      {
        col: 'Hạn Mức Công Nợ',
        req: 'Không',
        val: 'Số tiền VND lớn hơn 0. Bắt buộc điền nếu Loại Công Nợ có "Hạn Mức".',
      },
      {
        col: 'Ngày Thanh Toán / Lịch Thanh Toán',
        req: 'Không',
        val: 'Chỉ bắt buộc với lịch cố định. Tháng: số ngày 1-31, VD: "15,30". Tuần: Thứ 2 đến Thứ 7 hoặc Chủ nhật (lưu theo ISO 1-7: Thứ 2=1, Chủ nhật=7), VD: "Thứ 2, Thứ 5, Chủ nhật". Giá trị phải tăng dần, không trùng nhau.',
      },
      { col: '', req: '', val: '' },
      {
        col: 'GHI CHÚ',
        req: '',
        val: 'Mỗi dòng chỉ có một debtRuleType. Giá trị cũ dạng kết hợp như "Hạn Mức, Công Nợ 7 Ngày" sẽ bị từ chối để tránh hiểu sai chính sách.',
      },
      {
        col: '',
        req: '',
        val: 'Các cột lịch thanh toán là tùy chọn và nhận cả tiêu đề "Ngày Thanh Toán" lẫn "Lịch Thanh Toán".',
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
