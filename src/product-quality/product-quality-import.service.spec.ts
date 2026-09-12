import { ProductQualityImportService } from './product-quality-import.service';
import * as ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

describe('ProductQualityImportService (Unit)', () => {
  let service: ProductQualityImportService;
  let mockPrisma: any;
  let mockNotifications: any;
  let mockAuditLogs: any;

  beforeEach(() => {
    mockPrisma = {
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, code: 'KH001', name: 'Khách hàng Đại Lý', phone: '0901234567' },
        ]),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 10, code: 'SP001', name: 'Sữa Hạt Óc Chó', unit: 'Hộp', cargoType: 'DRY' },
        ]),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 100, code: 'HD001' },
        ]),
      },
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: 6, name: 'Kho Hà Nội', code: 'KHN' },
          { id: 1, name: 'Kho Sài Gòn', code: 'KSG' },
        ]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 5, name: 'Trần Thị Mai', email: 'mai@hisweetie.vn', phone: '0988888888' },
        ]),
      },
      productQualityTicket: {
        findMany: jest.fn().mockResolvedValue([
          { id: 200, code: 'CLSP000010', legacyCode: 'LARK-001', sourceRecordId: 'rec123' },
        ]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      productQualityTask: {
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(mockPrisma)),
    };

    mockNotifications = {
      createForUsers: jest.fn().mockResolvedValue(1),
    };

    mockAuditLogs = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    };

    service = new ProductQualityImportService(
      mockPrisma,
      mockNotifications,
      mockAuditLogs,
    );
  });

  describe('getTemplate', () => {
    it('generates a valid Excel template buffer with headers and sample row', async () => {
      const buffer = await service.getTemplate();
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      expect(sheet.name).toBe('ChatLuongHangHoa');
      expect(sheet.rowCount).toBeGreaterThanOrEqual(2);
      expect(sheet.getRow(1).getCell(1).value).toBe('Mã khách hàng');
      expect(sheet.getRow(1).getCell(3).value).toBe('Mã sản phẩm (*)');
    });
  });

  describe('preview', () => {
    it('correctly maps matched customers, products, and branches from Excel', async () => {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Sheet1');
      ws.addRow([
        'Mã khách hàng',
        'Tên khách hàng',
        'Mã sản phẩm',
        'Tên sản phẩm',
        'Số lượng',
        'Người phụ trách',
        'Kho',
        'Nguyên nhân',
      ]);
      ws.addRow([
        'KH001',
        'Khách hàng Đại Lý',
        'SP001',
        'Sữa Hạt Óc Chó',
        '10',
        'mai@hisweetie.vn',
        'Kho Hà Nội',
        'Bao bì móp méo',
      ]);

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const file = { buffer, originalname: 'test.xlsx' } as Express.Multer.File;

      const result = await service.preview(file, { id: 1, name: 'Admin' }, 6);
      expect(result.total).toBe(1);
      expect(result.valid).toBe(1);
      expect(result.invalid).toBe(0);
      expect(result.create).toBe(1);
      expect(result.matchedCustomers).toBe(1);
      expect(result.matchedProducts).toBe(1);

      const row = result.rows[0];
      expect(row.customerId).toBe(1);
      expect(row.productId).toBe(10);
      expect(row.quantity).toBe(10);
      expect(row.decisionMakerId).toBe(5);
      expect(row.branchId).toBe(6);
      expect(row.action).toBe('create');
    });

    it('flags rows with invalid quantity or missing information as errors', async () => {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Sheet1');
      ws.addRow(['Tên khách hàng', 'Tên sản phẩm', 'Số lượng']);
      ws.addRow(['', '', '-5']);

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const file = { buffer, originalname: 'invalid.xlsx' } as Express.Multer.File;

      const result = await service.preview(file, { id: 1, name: 'Admin' }, 6);
      expect(result.total).toBe(1);
      expect(result.valid).toBe(0);
      expect(result.invalid).toBe(1);
      expect(result.rows[0].errors.length).toBeGreaterThanOrEqual(2);
    });

    it('accepts legacy .xls workbooks', async () => {
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Tên khách hàng', 'Tên sản phẩm', 'Số lượng'],
        ['Khách hàng A', 'Sản phẩm B', 2],
      ]);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = Buffer.from(
        XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }),
      );
      const file = { buffer, originalname: 'legacy.xls' } as Express.Multer.File;

      const result = await service.preview(file, { id: 1, name: 'Admin' }, 6);
      expect(result.total).toBe(1);
      expect(result.valid).toBe(1);
      expect(result.rows[0].quantity).toBe(2);
    });

    it('identifies update action when sourceRecordId or legacyCode exists', async () => {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Sheet1');
      ws.addRow([
        'Mã Phiếu',
        'Tên Khách Hàng',
        'Tên Sản Phẩm',
        'Số Lượng',
        'Record ID',
      ]);
      ws.addRow([
        'LARK-001',
        'Khách A',
        'Sản phẩm B',
        '2',
        'rec123',
      ]);

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const file = { buffer, originalname: 'lark.xlsx' } as Express.Multer.File;

      const result = await service.preview(file, { id: 1, name: 'Admin' }, 6);
      expect(result.total).toBe(1);
      expect(result.valid).toBe(1);
      expect(result.update).toBe(1);
      expect(result.rows[0].action).toBe('update');
    });
  });

  describe('commit', () => {
    it('creates new ticket and department tasks on valid commit', async () => {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Sheet1');
      ws.addRow([
        'Tên khách hàng',
        'Tên sản phẩm',
        'Số lượng',
        'Bộ phận thực hiện',
      ]);
      ws.addRow([
        'Khách hàng mới',
        'Sản phẩm mới',
        '3',
        'Kho + Logistics, Kế Toán Kho',
      ]);

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const file = { buffer, originalname: 'commit.xlsx' } as Express.Multer.File;

      mockPrisma.productQualityTicket.findFirst.mockResolvedValue(null);
      mockPrisma.productQualityTicket.create.mockResolvedValue({ id: 301, code: 'CLSP000001' });

      const res = await service.commit(file, { id: 1, name: 'Admin' }, 6);
      expect(res.importedCount).toBe(1);
      expect(res.updatedCount).toBe(0);
      expect(mockPrisma.productQualityTicket.create).toHaveBeenCalled();
      expect(mockPrisma.productQualityTask.create).toHaveBeenCalledTimes(2);
      expect(mockAuditLogs.create).toHaveBeenCalled();
    });
  });
});
