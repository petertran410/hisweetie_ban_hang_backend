import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { QUALITY_STATUS, CODE_PREFIX } from './product-quality.service';

function norm(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

const HEADER_KEY_MAP: Record<string, string> = {
  // Legacy code / Ticket code
  maphieu: 'legacyCode',
  maphieucu: 'legacyCode',
  masoco: 'legacyCode',
  ticketcode: 'legacyCode',
  recordid: 'sourceRecordId',
  sourcerecordid: 'sourceRecordId',

  // Customer
  makhachhang: 'customerCode',
  makh: 'customerCode',
  customercode: 'customerCode',
  tenkhachhang: 'customerName',
  khachhang: 'customerName',
  customername: 'customerName',
  customer: 'customerName',

  // Product
  masanpham: 'productCode',
  masp: 'productCode',
  productcode: 'productCode',
  sku: 'productCode',
  tensanpham: 'productName',
  sanpham: 'productName',
  productname: 'productName',
  product: 'productName',

  // Unit
  donvitinh: 'unit',
  dvt: 'unit',
  unit: 'unit',

  // Source type
  nguonhang: 'sourceType',
  sourcetype: 'sourceType',

  // Quantity
  soluong: 'quantity',
  sl: 'quantity',
  quantity: 'quantity',
  qty: 'quantity',

  // Expiry date
  hansudung: 'expiryDate',
  hsd: 'expiryDate',
  expirydate: 'expiryDate',

  // Reason
  nguyennhan: 'reason',
  nguyennhansuco: 'reason',
  lydo: 'reason',
  reason: 'reason',

  // Classification
  phanloaisucobandau: 'initialClassification',
  phanloaibandau: 'initialClassification',
  phanloai: 'initialClassification',
  classification: 'initialClassification',

  // Feedback type
  loaiphanhoi: 'feedbackType',
  feedbacktype: 'feedbackType',

  // Severity
  mucdonghiemtrong: 'severity',
  mucdo: 'severity',
  severity: 'severity',

  // Responsibilities
  trachnhiemthuocve: 'responsibilities',
  trachnhiem: 'responsibilities',
  responsibilities: 'responsibilities',

  // Factory
  nhamaysanxuat: 'factoryName',
  nhamay: 'factoryName',
  factory: 'factoryName',
  factoryname: 'factoryName',

  // Assignee / Decision maker
  nguoiphutrach: 'decisionMaker',
  nguoiphutrachchinh: 'decisionMaker',
  nguoiquyetdinh: 'decisionMaker',
  decisionmaker: 'decisionMaker',
  assignee: 'decisionMaker',

  // Branch / Warehouse
  kho: 'branchName',
  chinhanh: 'branchName',
  khochinhanh: 'branchName',
  branch: 'branchName',
  branchname: 'branchName',

  // Invoice
  hoadon: 'invoiceCode',
  mahoadon: 'invoiceCode',
  mahd: 'invoiceCode',
  invoicecode: 'invoiceCode',
  invoice: 'invoiceCode',

  // Handling direction
  huongxuly: 'handlingDirection',
  handlingdirection: 'handlingDirection',

  // Assigned departments
  bophanthuchien: 'assignedDepartments',
  bophan: 'assignedDepartments',
  departments: 'assignedDepartments',

  // Status
  trangthaisuco: 'status',
  trangthai: 'status',
  status: 'status',

  // Note
  ghichu: 'note',
  note: 'note',

  // Lark Department checkboxes / feedback
  phongkinhdoanh: 'kdCheck',
  phongkinhdoanhphanhoineuco: 'kdFeedback',
  phongkinhdoanhphanhoi: 'kdFeedback',
  kinhdoanhphanhoi: 'kdFeedback',

  khologistics: 'khoCheck',
  khophanhoineuco: 'khoFeedback',
  khophanhoi: 'khoFeedback',

  ketoankho: 'ktCheck',
  ketoanphanhoineuco: 'ktFeedback',
  ketoanphanhoi: 'ktFeedback',

  thumua: 'tmCheck',
  thumuaphanhoineuco: 'tmFeedback',
  thumuaphanhoi: 'tmFeedback',

  // Lark timestamps
  ngaytao: 'createdAt',
  thoigiantao: 'createdAt',
  ngaycoxuly: 'handledAt',
  ngayhoanthanh: 'completedAt',
};

export interface QualityImportRow {
  row: number;
  legacyCode?: string;
  sourceRecordId?: string;
  customerName: string;
  customerCode?: string;
  customerId?: number;
  productName: string;
  productCode?: string;
  productId?: number;
  quantity: number;
  unit?: string;
  sourceType?: string;
  expiryDate?: Date;
  reason: string;
  initialClassification: string;
  feedbackType: string;
  severity?: string;
  responsibilities: string[];
  factoryName?: string;
  decisionMakerId?: number;
  decisionMakerName?: string;
  branchId?: number;
  branchName?: string;
  invoiceId?: number;
  invoiceCode?: string;
  handlingDirection?: string;
  assignedDepartments: string[];
  status: string;
  isCompleted: boolean;
  handledAt?: Date;
  dueAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  note?: string;
  taskFeedbacks: Record<string, string>;
  taskDones: Record<string, boolean>;
  action: 'create' | 'update' | 'error';
  errors: string[];
}

export interface QualityImportPreviewResult {
  total: number;
  valid: number;
  invalid: number;
  create: number;
  update: number;
  matchedCustomers: number;
  matchedProducts: number;
  matchedInvoices: number;
  rows: QualityImportRow[];
}

@Injectable()
export class ProductQualityImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /**
   * Tạo file Excel mẫu chuẩn hóa
   */
  async getTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('ChatLuongHangHoa');

    worksheet.columns = [
      { header: 'Mã khách hàng', key: 'customerCode', width: 16 },
      { header: 'Tên khách hàng (*)', key: 'customerName', width: 28 },
      { header: 'Mã sản phẩm (*)', key: 'productCode', width: 16 },
      { header: 'Tên sản phẩm', key: 'productName', width: 28 },
      { header: 'Số lượng (*)', key: 'quantity', width: 12 },
      { header: 'Đơn vị tính', key: 'unit', width: 12 },
      { header: 'Nguồn hàng', key: 'sourceType', width: 14 },
      { header: 'Hạn sử dụng (YYYY-MM-DD)', key: 'expiryDate', width: 22 },
      { header: 'Nguyên nhân sự cố (*)', key: 'reason', width: 32 },
      { header: 'Phân loại ban đầu (*)', key: 'initialClassification', width: 24 },
      { header: 'Loại phản hồi (*)', key: 'feedbackType', width: 24 },
      { header: 'Mức độ nghiêm trọng', key: 'severity', width: 18 },
      { header: 'Người phụ trách (*)', key: 'decisionMaker', width: 24 },
      { header: 'Kho / Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã hóa đơn liên quan', key: 'invoiceCode', width: 20 },
      { header: 'Hướng xử lý', key: 'handlingDirection', width: 32 },
      { header: 'Bộ phận thực hiện', key: 'assignedDepartments', width: 28 },
      { header: 'Trạng thái', key: 'status', width: 16 },
      { header: 'Ghi chú', key: 'note', width: 28 },
      { header: 'Mã phiếu cũ', key: 'legacyCode', width: 16 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF3F4F6' },
    };

    worksheet.addRow({
      customerCode: 'KH0001',
      customerName: 'Khách hàng A',
      productCode: 'SP0001',
      productName: 'Trà Sữa Trân Châu 500ml',
      quantity: 5,
      unit: 'Chai',
      sourceType: 'Hàng thường',
      expiryDate: '2026-12-31',
      reason: 'Bao bì bị rách góc khi nhận hàng',
      initialClassification: 'Chất Lượng Sản Phẩm',
      feedbackType: 'Hàng Lỗi / Hỏng',
      severity: 'Trung',
      decisionMaker: 'admin@hisweetie.vn',
      branchName: 'Kho Hà Nội',
      invoiceCode: 'HD000123',
      handlingDirection: 'Đổi sản phẩm mới cho khách',
      assignedDepartments: 'Kho + Logistics, Kế Toán Kho',
      status: 'Đang xử lý',
      note: 'Khách thông báo sáng nay',
      legacyCode: 'CLSP000001',
    });

    for (let r = 2; r <= 1000; r++) {
      // Dropdown phân loại
      worksheet.getCell(`J${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Chất Lượng Sản Phẩm,Số lượng / Chủng loại,Vận chuyển / Đóng gói"'],
      };
      // Dropdown mức độ
      worksheet.getCell(`L${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Cao,Trung,Thấp"'],
      };
      // Dropdown trạng thái
      worksheet.getCell(`R${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Mới,Đang xử lý,Đang khắc phục,Hoàn thành,Dừng"'],
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private value(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const cell = value as any;
      if (Array.isArray(cell.richText)) {
        return cell.richText
          .map((part: any) => this.value(part?.text))
          .join('')
          .trim();
      }
      if (cell.text !== undefined) return this.value(cell.text);
      if (cell.result !== undefined) return this.value(cell.result);
    }
    return '';
  }

  private parseDate(val: any): Date | undefined {
    if (!val) return undefined;
    if (val instanceof Date) return isNaN(val.getTime()) ? undefined : val;
    if (typeof val === 'number') {
      if (val > 100000000000) {
        const d = new Date(val);
        return isNaN(d.getTime()) ? undefined : d;
      }
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      return isNaN(d.getTime()) ? undefined : d;
    }
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s) return undefined;
      if (/^\d{11,14}$/.test(s)) {
        return new Date(Number(s));
      }
      const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (dmy) {
        const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`);
        return isNaN(d.getTime()) ? undefined : d;
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    }
    return undefined;
  }

  private parseStatus(raw: string): string {
    const s = (raw || '').trim().toLowerCase();
    if (s.includes('hoàn thành') || s === 'done' || s === 'completed') return QUALITY_STATUS.COMPLETED;
    if (s.includes('khắc phục') || s === 'remediating') return QUALITY_STATUS.REMEDIATING;
    if (s.includes('đang xử lý') || s === 'in_progress') return QUALITY_STATUS.IN_PROGRESS;
    if (s.includes('dừng') || s.includes('ended') || s.includes('kết thúc')) return QUALITY_STATUS.ENDED;
    return QUALITY_STATUS.NEW;
  }

  private parseDepartments(raw: string, rowObj: any): string[] {
    const depts: string[] = [];
    if (raw) {
      const parts = raw.split(/[,;\n]+/).map((p) => p.trim());
      for (const p of parts) {
        const n = norm(p);
        if (n.includes('kinhdoanh') && !depts.includes('Kinh Doanh')) depts.push('Kinh Doanh');
        if ((n.includes('kho') || n.includes('logistics')) && !depts.includes('Kho + Logistics')) depts.push('Kho + Logistics');
        if (n.includes('ketoan') && !depts.includes('Kế Toán Kho')) depts.push('Kế Toán Kho');
        if (n.includes('thumua') && !depts.includes('Thu Mua')) depts.push('Thu Mua');
      }
    }
    if ((rowObj.kdCheck || rowObj.kdFeedback) && !depts.includes('Kinh Doanh')) depts.push('Kinh Doanh');
    if ((rowObj.khoCheck || rowObj.khoFeedback) && !depts.includes('Kho + Logistics')) depts.push('Kho + Logistics');
    if ((rowObj.ktCheck || rowObj.ktFeedback) && !depts.includes('Kế Toán Kho')) depts.push('Kế Toán Kho');
    if ((rowObj.tmCheck || rowObj.tmFeedback) && !depts.includes('Thu Mua')) depts.push('Thu Mua');
    return depts;
  }

  /**
   * Đọc file Excel và trả về danh sách đối tượng dòng thô
   */
  private async parseWorkbookRows(file: Express.Multer.File): Promise<any[]> {
    if (!file || !file.buffer) throw new BadRequestException('Chưa chọn file');

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as any);
    } catch {
      throw new BadRequestException('Không đọc được file Excel (.xlsx hoặc .xls)');
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File Excel trống không có trang dữ liệu');

    // Xác định cột ở dòng 1
    const colMap = new Map<number, string>();
    sheet.getRow(1).eachCell((cell, colNumber) => {
      const rawText = this.value(cell.value);
      const normalized = norm(rawText);
      const mappedKey = HEADER_KEY_MAP[normalized];
      if (mappedKey) {
        colMap.set(colNumber, mappedKey);
      }
    });

    if (colMap.size === 0) {
      throw new BadRequestException(
        'Không nhận diện được tiêu đề cột phù hợp. Vui lòng tải file mẫu để xem định dạng.',
      );
    }

    const rawRows: any[] = [];

    sheet.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return;

      const rowObj: any = { _row: rowNumber };
      let hasData = false;

      colMap.forEach((key, colNumber) => {
        const cell = excelRow.getCell(colNumber);
        const val = this.value(cell.value);
        if (val) hasData = true;
        rowObj[key] = val;
        // Nếu là ô Date hoặc số timestamp, lưu raw value
        if (cell.value instanceof Date || typeof cell.value === 'number') {
          rowObj[`${key}_raw`] = cell.value;
        }
      });

      if (hasData) {
        rawRows.push(rowObj);
      }
    });

    return rawRows;
  }

  /**
   * Bước 1: Preview dữ liệu từ file Excel, đối chiếu DB và không ghi gì
   */
  async preview(
    file: Express.Multer.File,
    currentUser: any,
    defaultBranchId?: number,
  ): Promise<QualityImportPreviewResult> {
    const rawRows = await this.parseWorkbookRows(file);

    // Tải trước dữ liệu tra cứu từ DB
    const [customers, products, invoices, branches, users, existingTickets] =
      await Promise.all([
        this.prisma.customer.findMany({
          select: { id: true, code: true, name: true, phone: true },
        }),
        this.prisma.product.findMany({
          select: { id: true, code: true, name: true, unit: true, cargoType: true },
        }),
        this.prisma.invoice.findMany({
          select: { id: true, code: true },
        }),
        this.prisma.branch.findMany({
          select: { id: true, name: true, code: true },
        }),
        this.prisma.user.findMany({
          select: { id: true, name: true, email: true, phone: true },
        }),
        this.prisma.productQualityTicket.findMany({
          select: { id: true, code: true, legacyCode: true, sourceRecordId: true },
        }),
      ]);

    const customerByCode = new Map(customers.filter((c) => c.code).map((c) => [c.code!.toUpperCase(), c]));
    const customerByName = new Map(customers.map((c) => [norm(c.name), c]));

    const productByCode = new Map(products.filter((p) => p.code).map((p) => [p.code!.toUpperCase(), p]));
    const productByName = new Map(products.map((p) => [norm(p.name), p]));

    const invoiceByCode = new Map(invoices.map((i) => [i.code.toUpperCase(), i]));

    const branchByName = new Map(branches.map((b) => [norm(b.name), b]));
    const branchById = new Map(branches.map((b) => [b.id, b]));

    const userByEmail = new Map(users.filter((u) => u.email).map((u) => [norm(u.email), u]));
    const userByName = new Map(users.map((u) => [norm(u.name), u]));
    const userById = new Map(users.map((u) => [u.id, u]));

    const existingBySourceId = new Map(
      existingTickets.filter((t) => t.sourceRecordId).map((t) => [t.sourceRecordId!, t]),
    );
    const existingByLegacyCode = new Map(
      existingTickets.filter((t) => t.legacyCode).map((t) => [t.legacyCode!.toUpperCase(), t]),
    );
    const existingByCode = new Map(
      existingTickets.map((t) => [t.code.toUpperCase(), t]),
    );

    let matchedCustomers = 0;
    let matchedProducts = 0;
    let matchedInvoices = 0;

    const rows: QualityImportRow[] = [];

    for (const raw of rawRows) {
      const errors: string[] = [];

      // 1. Khách hàng
      const customerCode = (raw.customerCode || '').trim().toUpperCase();
      const customerNameInput = (raw.customerName || '').trim();
      let matchedCust = customerCode ? customerByCode.get(customerCode) : undefined;
      if (!matchedCust && customerNameInput) {
        matchedCust = customerByName.get(norm(customerNameInput));
      }

      if (matchedCust) matchedCustomers++;
      const finalCustomerName = matchedCust?.name || customerNameInput || customerCode;
      if (!finalCustomerName) {
        errors.push('Thiếu thông tin khách hàng (mã hoặc tên)');
      }

      // 2. Sản phẩm
      const productCodeInput = (raw.productCode || '').trim().toUpperCase();
      const productNameInput = (raw.productName || '').trim();
      let matchedProd = productCodeInput ? productByCode.get(productCodeInput) : undefined;
      if (!matchedProd && productNameInput) {
        // Thử trích xuất mã SP từ tên (VD: SP000390)
        const skuMatch = productNameInput.match(/SP\d{6}|[A-Z0-9]{5,15}/i);
        if (skuMatch) {
          matchedProd = productByCode.get(skuMatch[0].toUpperCase());
        }
        if (!matchedProd) {
          matchedProd = productByName.get(norm(productNameInput));
        }
      }

      if (matchedProd) matchedProducts++;
      const finalProductName = matchedProd?.name || productNameInput || productCodeInput;
      if (!finalProductName) {
        errors.push('Thiếu thông tin sản phẩm (mã hoặc tên)');
      }

      // 3. Số lượng
      const rawQty = raw.quantity ? parseFloat(String(raw.quantity).replace(/,/g, '')) : 1;
      const quantity = isNaN(rawQty) || rawQty <= 0 ? 0 : rawQty;
      if (quantity <= 0) {
        errors.push('Số lượng sự cố phải lớn hơn 0');
      }

      // 4. Nguyên nhân
      const reason = (raw.reason || '').trim() || 'Sự cố phản ánh từ khách hàng';

      // 5. Phân loại sự cố ban đầu
      let initialClassification = 'Chất Lượng Sản Phẩm';
      const normClass = norm(raw.initialClassification);
      if (normClass.includes('soluong') || normClass.includes('chungloai')) {
        initialClassification = 'Số lượng / Chủng loại';
      } else if (normClass.includes('vanchuyen') || normClass.includes('donggoi')) {
        initialClassification = 'Vận chuyển / Đóng gói';
      }

      // 6. Loại phản hồi
      const feedbackType = (raw.feedbackType || '').trim() || 'Hàng Lỗi / Hỏng';

      // 7. Mức độ nghiêm trọng
      let severity = 'Trung';
      const normSev = norm(raw.severity);
      if (normSev.includes('cao')) severity = 'Cao';
      else if (normSev.includes('thap')) severity = 'Thấp';

      // 8. Người phụ trách chính (decisionMaker)
      let decisionMakerId: number | undefined;
      let decisionMakerName: string | undefined;
      const dmInput = (raw.decisionMaker || '').trim();
      if (dmInput) {
        const byEmail = userByEmail.get(norm(dmInput));
        const byName = userByName.get(norm(dmInput));
        const byId = !isNaN(Number(dmInput)) ? userById.get(Number(dmInput)) : undefined;
        const matchedUser = byEmail || byName || byId;
        if (matchedUser) {
          decisionMakerId = matchedUser.id;
          decisionMakerName = matchedUser.name;
        }
      }
      if (!decisionMakerId) {
        // Mặc định giao cho user đang import nếu không nhận diện được
        decisionMakerId = currentUser?.id;
        decisionMakerName = currentUser?.name;
      }

      // 9. Kho / Chi nhánh
      let branchId: number | undefined;
      let branchName: string | undefined;
      const branchInput = (raw.branchName || '').trim();
      if (branchInput) {
        const normB = norm(branchInput);
        if (normB.includes('hanoi')) {
          const b = branchByName.get('khohanoi') || branches.find((item) => item.id === 6);
          branchId = b?.id;
          branchName = b?.name || 'Kho Hà Nội';
        } else if (normB.includes('saigon')) {
          const b = branchByName.get('khosaigon') || branches.find((item) => item.id === 1);
          branchId = b?.id;
          branchName = b?.name || 'Kho Sài Gòn';
        } else {
          const matchedBranch = branchByName.get(normB);
          if (matchedBranch) {
            branchId = matchedBranch.id;
            branchName = matchedBranch.name;
          }
        }
      }
      if (!branchId) {
        branchId = defaultBranchId || currentUser?.branchId || branches[0]?.id;
        branchName = branchById.get(branchId || 0)?.name || branches[0]?.name;
      }

      // 10. Hóa đơn liên quan
      let invoiceId: number | undefined;
      let invoiceCode: string | undefined;
      const invInput = (raw.invoiceCode || '').trim().toUpperCase();
      if (invInput) {
        const matchedInv = invoiceByCode.get(invInput);
        if (matchedInv) {
          invoiceId = matchedInv.id;
          invoiceCode = matchedInv.code;
          matchedInvoices++;
        } else {
          invoiceCode = invInput;
        }
      }

      // 11. Hướng xử lý & Trạng thái & SLA
      const handlingDirection = (raw.handlingDirection || '').trim();
      const status = this.parseStatus(raw.status);
      const isCompleted = status === QUALITY_STATUS.COMPLETED;

      // Dates
      const createdAt = this.parseDate(raw.createdAt_raw || raw.createdAt) || new Date();
      const handledAt = this.parseDate(raw.handledAt_raw || raw.handledAt) || (handlingDirection ? new Date() : undefined);
      const completedAt = isCompleted ? (this.parseDate(raw.completedAt_raw || raw.completedAt) || new Date()) : undefined;
      const dueAt = handledAt ? new Date(handledAt.getTime() + 5 * 24 * 60 * 60 * 1000) : undefined;
      const expiryDate = this.parseDate(raw.expiryDate_raw || raw.expiryDate);

      // 12. Bộ phận thực hiện & Task feedbacks
      const assignedDepartments = this.parseDepartments(raw.assignedDepartments || '', raw);
      const taskFeedbacks: Record<string, string> = {
        'Kinh Doanh': raw.kdFeedback || '',
        'Kho + Logistics': raw.khoFeedback || '',
        'Kế Toán Kho': raw.ktFeedback || '',
        'Thu Mua': raw.tmFeedback || '',
      };
      const taskDones: Record<string, boolean> = {
        'Kinh Doanh': !!raw.kdCheck || !!raw.kdFeedback,
        'Kho + Logistics': !!raw.khoCheck || !!raw.khoFeedback,
        'Kế Toán Kho': !!raw.ktCheck || !!raw.ktFeedback,
        'Thu Mua': !!raw.tmCheck || !!raw.tmFeedback,
      };

      // 13. Mã cũ / Record ID để đối chiếu
      const legacyCode = (raw.legacyCode || '').trim() || undefined;
      const sourceRecordId = (raw.sourceRecordId || '').trim() || undefined;

      // Action determination
      let action: 'create' | 'update' | 'error' = 'create';
      if (errors.length > 0) {
        action = 'error';
      } else if (
        (sourceRecordId && existingBySourceId.has(sourceRecordId)) ||
        (legacyCode && existingByLegacyCode.has(legacyCode.toUpperCase())) ||
        (legacyCode && existingByCode.has(legacyCode.toUpperCase()))
      ) {
        action = 'update';
      }

      rows.push({
        row: raw._row,
        legacyCode,
        sourceRecordId,
        customerName: finalCustomerName,
        customerCode: matchedCust?.code || customerCode || undefined,
        customerId: matchedCust?.id,
        productName: finalProductName,
        productCode: matchedProd?.code || productCodeInput || undefined,
        productId: matchedProd?.id,
        quantity,
        unit: raw.unit || matchedProd?.unit || undefined,
        sourceType: raw.sourceType || (matchedProd?.cargoType === 'COLD' ? 'Hàng lạnh' : 'Hàng thường'),
        expiryDate,
        reason,
        initialClassification,
        feedbackType,
        severity,
        responsibilities: raw.responsibilities ? String(raw.responsibilities).split(/[,;]+/).map((s) => s.trim()) : [],
        factoryName: raw.factoryName || undefined,
        decisionMakerId,
        decisionMakerName,
        branchId,
        branchName,
        invoiceId,
        invoiceCode,
        handlingDirection: handlingDirection || undefined,
        assignedDepartments,
        status,
        isCompleted,
        handledAt,
        dueAt,
        completedAt,
        createdAt,
        note: raw.note || undefined,
        taskFeedbacks,
        taskDones,
        action,
        errors,
      });
    }

    const total = rows.length;
    const valid = rows.filter((r) => r.errors.length === 0).length;
    const invalid = rows.filter((r) => r.errors.length > 0).length;
    const create = rows.filter((r) => r.action === 'create').length;
    const update = rows.filter((r) => r.action === 'update').length;

    return {
      total,
      valid,
      invalid,
      create,
      update,
      matchedCustomers,
      matchedProducts,
      matchedInvoices,
      rows,
    };
  }

  /**
   * Bước 2: Commit import ghi dữ liệu vào DB (chỉ thực hiện khi preview hợp lệ)
   */
  async commit(
    file: Express.Multer.File,
    currentUser: any,
    defaultBranchId?: number,
  ) {
    const preview = await this.preview(file, currentUser, defaultBranchId);

    if (preview.invalid > 0) {
      throw new BadRequestException({
        message: `File còn ${preview.invalid} dòng lỗi. Vui lòng sửa lại file và kiểm tra trước khi import.`,
        ...preview,
      });
    }

    if (preview.valid === 0) {
      throw new BadRequestException('File không có bản ghi hợp lệ nào để import.');
    }

    // Lấy số thứ tự mã phiếu tiếp theo
    const last = await this.prisma.productQualityTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { id: 'desc' },
      select: { code: true },
    });
    let nextNum = 1;
    if (last) {
      const parsed = parseInt(last.code.replace(CODE_PREFIX, ''), 10);
      if (!isNaN(parsed)) nextNum = parsed + 1;
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (const item of preview.rows) {
      if (item.errors.length > 0) continue;

      // Tìm xem có ticket cũ không
      let existing = item.sourceRecordId
        ? await this.prisma.productQualityTicket.findUnique({
            where: { sourceRecordId: item.sourceRecordId },
            include: { tasks: true },
          })
        : null;

      if (!existing && item.legacyCode) {
        existing = await this.prisma.productQualityTicket.findFirst({
          where: {
            OR: [
              { legacyCode: item.legacyCode },
              { code: item.legacyCode },
            ],
          },
          include: { tasks: true },
        });
      }

      if (existing) {
        // Cập nhật ticket hiện có
        await this.prisma.$transaction(async (tx) => {
          await tx.productQualityTicket.update({
            where: { id: existing!.id },
            data: {
              customerId: item.customerId,
              customerCode: item.customerCode,
              customerName: item.customerName,
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              unit: item.unit,
              sourceType: item.sourceType,
              quantity: item.quantity,
              expiryDate: item.expiryDate,
              reason: item.reason,
              initialClassification: item.initialClassification,
              feedbackType: item.feedbackType,
              severity: item.severity,
              responsibilities: item.responsibilities,
              factoryName: item.factoryName,
              branchId: item.branchId || existing!.branchId,
              branchName: item.branchName || existing!.branchName,
              invoiceId: item.invoiceId || existing!.invoiceId,
              invoiceCode: item.invoiceCode || existing!.invoiceCode,
              decisionMakerId: item.decisionMakerId || existing!.decisionMakerId,
              decisionMakerName: item.decisionMakerName || existing!.decisionMakerName,
              handlingDirection: item.handlingDirection || existing!.handlingDirection,
              assignedDepartments: item.assignedDepartments.length > 0 ? item.assignedDepartments : existing!.assignedDepartments,
              status: item.status,
              isCompleted: item.isCompleted,
              handledAt: item.handledAt || existing!.handledAt,
              dueAt: item.dueAt || existing!.dueAt,
              completedAt: item.completedAt || existing!.completedAt,
              note: item.note || existing!.note,
              updatedById: currentUser.id,
            },
          });

          // Cập nhật tasks
          const existingTasks = existing!.tasks || [];
          for (const dept of item.assignedDepartments) {
            const task = existingTasks.find((t) => t.department === dept);
            const feedback = item.taskFeedbacks[dept];
            const isCompleted = item.taskDones[dept] ?? false;

            if (!task) {
              await tx.productQualityTask.create({
                data: {
                  ticketId: existing!.id,
                  department: dept,
                  feedback: feedback || null,
                  isCompleted,
                  completedAt: isCompleted ? new Date() : null,
                },
              });
            } else if (feedback || isCompleted) {
              await tx.productQualityTask.update({
                where: { id: task.id },
                data: {
                  feedback: feedback || task.feedback,
                  isCompleted: isCompleted || task.isCompleted,
                },
              });
            }
          }
        });

        updatedCount++;
      } else {
        // Tạo mới ticket
        const code = `${CODE_PREFIX}${String(nextNum++).padStart(6, '0')}`;

        await this.prisma.$transaction(async (tx) => {
          const created = await tx.productQualityTicket.create({
            data: {
              code,
              legacyCode: item.legacyCode || code,
              sourceRecordId: item.sourceRecordId,
              branchId: item.branchId,
              branchName: item.branchName,
              customerId: item.customerId,
              customerCode: item.customerCode,
              customerName: item.customerName,
              productId: item.productId,
              productCode: item.productCode,
              productName: item.productName,
              unit: item.unit,
              sourceType: item.sourceType,
              quantity: item.quantity,
              expiryDate: item.expiryDate,
              reason: item.reason,
              initialClassification: item.initialClassification,
              feedbackType: item.feedbackType,
              severity: item.severity,
              responsibilities: item.responsibilities,
              factoryName: item.factoryName,
              note: item.note,
              invoiceId: item.invoiceId,
              invoiceCode: item.invoiceCode,
              decisionMakerId: item.decisionMakerId,
              decisionMakerName: item.decisionMakerName,
              handlingDirection: item.handlingDirection,
              assignedDepartments: item.assignedDepartments,
              status: item.status,
              isCompleted: item.isCompleted,
              handledAt: item.handledAt,
              dueAt: item.dueAt,
              completedAt: item.completedAt,
              createdAt: item.createdAt || new Date(),
              createdById: currentUser.id,
              createdByName: currentUser.name || 'Nhân viên',
            },
          });

          // Tạo tasks cho các bộ phận
          for (const dept of item.assignedDepartments) {
            const feedback = item.taskFeedbacks[dept];
            const isCompleted = item.taskDones[dept] ?? false;

            await tx.productQualityTask.create({
              data: {
                ticketId: created.id,
                department: dept,
                feedback: feedback || null,
                isCompleted,
                completedAt: isCompleted ? new Date() : null,
              },
            });
          }
        });

        importedCount++;
      }
    }

    // Ghi audit log
    void this.auditLogsService.create({
      actionType: 'POST',
      actionCode: 'product_quality.import_excel',
      message: `Import Excel sự cố chất lượng: ${importedCount} tạo mới, ${updatedCount} cập nhật trên ${preview.total} dòng`,
      entityType: 'product_quality_ticket',
      userId: currentUser.id,
      userName: currentUser.name || 'Nhân viên',
      category: 'Sản phẩm',
      severity: 'info',
      snapshot: {
        total: preview.total,
        importedCount,
        updatedCount,
      },
    });

    return {
      total: preview.total,
      importedCount,
      updatedCount,
      skippedCount: 0,
      matchedCustomers: preview.matchedCustomers,
      matchedProducts: preview.matchedProducts,
      matchedInvoices: preview.matchedInvoices,
    };
  }
}
