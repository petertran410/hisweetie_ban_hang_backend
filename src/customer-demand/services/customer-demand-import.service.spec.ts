import * as ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { CustomerDemandImportService } from './customer-demand-import.service';

describe('CustomerDemandImportService', () => {
  const repository = {
    findCustomersByCodes: jest.fn(),
    findProductsByCodes: jest.fn(),
    createManyDrafts: jest.fn(),
  };
  const auditLogs = { create: jest.fn() };
  const service = new CustomerDemandImportService(
    repository as any,
    auditLogs as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findCustomersByCodes.mockResolvedValue([
      { id: 1, code: 'KH001', name: 'Khách OEM', isActive: true },
    ]);
    repository.findProductsByCodes.mockResolvedValue([
      {
        id: 11,
        code: 'SP001',
        name: 'Nguyên liệu 1',
        unit: 'gói',
        conversionValue: 24,
        isActive: true,
      },
      {
        id: 12,
        code: 'SP002',
        name: 'Nguyên liệu 2',
        unit: 'gói',
        conversionValue: 10,
        isActive: true,
      },
    ]);
    repository.createManyDrafts.mockResolvedValue([99]);
  });

  it('tạo được file mẫu', async () => {
    const buffer = await service.template();
    expect(buffer).toBeTruthy();
  });

  it('preview gom 1 khách thành 1 phiếu và quy đổi thùng', async () => {
    const file = await excelFile([
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-10', 10, 'Đơn vị cơ bản', 'OEM'],
      ['KH001', 'Khách OEM', 'SP002', 'NL2', '2026-10', 2, 'Thùng', 'OEM'],
    ]);
    const preview = await service.preview(file);
    expect(preview.invalid).toBe(0);
    expect(preview.vouchers).toBe(1);
    expect(preview.months).toBe(1);
    expect(preview.groups[0].months[0].lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 11,
          quantity: 10,
          unit: 'BASE',
          quantityBase: 10,
        }),
        expect.objectContaining({
          productId: 12,
          quantity: 2,
          unit: 'CARTON',
          quantityBase: 20,
        }),
      ]),
    );
  });

  it('preview báo lỗi khi không tìm thấy khách/sản phẩm', async () => {
    repository.findCustomersByCodes.mockResolvedValue([]);
    const file = await excelFile([
      ['KH999', '', 'SP999', '', '2026-10', 5, '', ''],
    ]);
    const preview = await service.preview(file);
    expect(preview.invalid).toBe(1);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Không tìm thấy khách hàng/);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Không tìm thấy sản phẩm/);
  });

  it('commit từ chối khi còn dòng lỗi', async () => {
    const file = await excelFile([['', '', '', '', '', '', '', '']]);
    await expect(service.commit(file, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('preview tách 2 phiếu khi trùng SKU cùng tháng', async () => {
    const file = await excelFile([
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-09', 15, 'Đơn vị cơ bản', ''],
      ['KH001', 'Khách OEM', 'SP002', 'NL2', '2026-09', 5, 'Đơn vị cơ bản', 'OEM'],
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-09', 15, 'Đơn vị cơ bản', 'Bổ sung demand tháng 9'],
    ]);
    const preview = await service.preview(file);
    expect(preview.invalid).toBe(0);
    expect(preview.vouchers).toBe(2);
    expect(preview.rows[0].voucherIndex).toBe(1);
    expect(preview.rows[2].voucherIndex).toBe(2);
    expect(preview.groups[1].note).toBe('Bổ sung demand tháng 9');
    expect(preview.groups[0].months[0].lines.map((line) => line.productId).sort()).toEqual([
      11, 12,
    ]);
  });

  it('preview nhận tháng 2026-9 và tách trùng SKU thành 2 phiếu', async () => {
    const file = await excelFile([
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-9', 15, 'Đơn vị cơ bản', ''],
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-9', 15, 'Đơn vị cơ bản', 'Bổ sung demand tháng 9'],
    ]);
    const preview = await service.preview(file);
    expect(preview.invalid).toBe(0);
    expect(preview.vouchers).toBe(2);
    expect(preview.rows.map((row) => row.month)).toEqual(['2026-09', '2026-09']);
    expect(preview.rows[0].voucherIndex).toBe(1);
    expect(preview.rows[1].voucherIndex).toBe(2);
  });

  it('commit tạo đúng số phiếu sau khi tách trùng SKU', async () => {
    repository.createManyDrafts.mockResolvedValue([99, 100]);
    const file = await excelFile([
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-09', 15, 'BASE', ''],
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-09', 15, 'BASE', 'Bổ sung'],
    ]);
    const result = await service.commit(file, 7);
    expect(repository.createManyDrafts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ customerId: 1 }),
        expect.objectContaining({ customerId: 1 }),
      ]),
    );
    expect(result).toMatchObject({ imported: 2, vouchers: 2, ids: [99, 100] });
  });

  it('commit tạo phiếu nháp khi file hợp lệ', async () => {
    const file = await excelFile([
      ['KH001', 'Khách OEM', 'SP001', 'NL1', '2026-10', 10, 'BASE', 'OEM'],
    ]);
    const result = await service.commit(file, 7);
    expect(repository.createManyDrafts).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      imported: 1,
      vouchers: 1,
      ids: [99],
    });
    expect(auditLogs.create).toHaveBeenCalled();
  });
});

async function excelFile(rows: Array<Array<string | number>>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Demand');
  sheet.addRow([
    'Mã khách hàng',
    'Tên khách hàng',
    'Mã sản phẩm',
    'Tên sản phẩm',
    'Tháng cần hàng',
    'Số lượng',
    'Đơn vị',
    'Ghi chú phiếu',
  ]);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer,
    originalname: 'demand.xlsx',
    mimetype:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  } as unknown as Express.Multer.File;
}
