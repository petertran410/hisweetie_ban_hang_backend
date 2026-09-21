import {
  groupCustomerDemandImportRows,
  parseImportMonth,
  parseImportQuantity,
  parseImportUnit,
  validateImportRow,
} from './customer-demand-import';

describe('customer-demand import parsers', () => {
  it('nhận tháng YYYY-MM, YYYY/MM, MM/YYYY và Date', () => {
    expect(parseImportMonth('2026-10')).toBe('2026-10');
    expect(parseImportMonth('2026/9')).toBe('2026-09');
    expect(parseImportMonth('2026-9')).toBe('2026-09');
    expect(parseImportMonth('10/2026')).toBe('2026-10');
    expect(parseImportMonth('2026-10-15')).toBe('2026-10');
    expect(parseImportMonth(new Date(2026, 9, 1))).toBe('2026-10');
  });

  it('nhận Excel serial date', () => {
    const serial =
      (Date.UTC(2026, 9, 1) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(parseImportMonth(serial)).toBe('2026-10');
  });

  it('từ chối tháng không hợp lệ', () => {
    expect(parseImportMonth('')).toBeNull();
    expect(parseImportMonth('13/2026')).toBeNull();
    expect(parseImportMonth('tháng 10')).toBeNull();
  });

  it('parse số lượng theo dấu phẩy/chấm', () => {
    expect(parseImportQuantity('10')).toBe(10);
    expect(parseImportQuantity('1,5')).toBe(1.5);
    expect(parseImportQuantity('1.234,5')).toBe(1234.5);
    expect(parseImportQuantity('1,234.5')).toBe(1234.5);
    expect(parseImportQuantity('abc')).toBeNull();
  });

  it('parse đơn vị BASE/CARTON', () => {
    expect(parseImportUnit('')).toBe('BASE');
    expect(parseImportUnit('Đơn vị cơ bản')).toBe('BASE');
    expect(parseImportUnit('Thùng')).toBe('CARTON');
    expect(parseImportUnit('CARTON')).toBe('CARTON');
    expect(parseImportUnit('kg')).toBeNull();
  });

  it('validate dòng thiếu dữ liệu bắt buộc', () => {
    const result = validateImportRow({
      row: 2,
      customerCode: '',
      customerName: '',
      productCode: '',
      productName: '',
      monthRaw: '',
      quantityRaw: '0',
      unitRaw: 'kg',
      note: '',
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Thiếu mã khách hàng',
        'Thiếu mã sản phẩm',
        'Tháng cần hàng phải có dạng YYYY-MM',
        'Số lượng phải lớn hơn 0',
        'Đơn vị chỉ nhận Đơn vị cơ bản hoặc Thùng',
      ]),
    );
  });

  it('gom theo khách + tháng và giữ các dòng SKU trùng', () => {
    const rows = [
      {
        ...validRow(2, 'KH01', 'SP01', '2026-10', 10),
        customerId: 1,
        productId: 11,
        quantityBase: 10,
        conversionValue: 1,
      },
      {
        ...validRow(3, 'KH01', 'SP02', '2026-10', 5),
        customerId: 1,
        productId: 12,
        quantityBase: 5,
        conversionValue: 1,
        note: 'OEM tháng 10',
      },
      {
        ...validRow(4, 'KH01', 'SP01', '2026-10', 7),
        customerId: 1,
        productId: 11,
        quantityBase: 7,
        conversionValue: 1,
        note: 'Bổ sung',
      },
      {
        ...validRow(5, 'KH01', 'SP03', '2026-10', 4),
        customerId: 1,
        productId: 13,
        quantityBase: 4,
        conversionValue: 1,
      },
      {
        ...validRow(6, 'KH02', 'SP01', '2026-11', 3),
        customerId: 2,
        productId: 11,
        quantityBase: 3,
        conversionValue: 1,
      },
    ];

    const groups = groupCustomerDemandImportRows(rows);
    expect(rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(groups).toHaveLength(2);
    expect(groups[0].customerId).toBe(1);
    expect(groups[0].voucherIndex).toBe(1);
    expect(groups[0].note).toBe('OEM tháng 10');
    expect(groups[0].month).toBe('2026-10');
    expect(groups[0].lines.map((line) => line.productId)).toEqual([
      11, 12, 11, 13,
    ]);
    expect(groups[1].customerId).toBe(2);
    expect(groups[1].voucherIndex).toBe(2);
    expect(groups[1].month).toBe('2026-11');
    expect(rows[0].voucherIndex).toBe(1);
    expect(rows[2].voucherIndex).toBe(1);
    expect(rows[3].voucherIndex).toBe(1);
    expect(rows[4].voucherIndex).toBe(2);
  });

  it('file mẫu: cùng khách + tháng giữ 3 dòng trong một phiếu', () => {
    const rows = [
      {
        ...validRow(39, 'KH004517', 'SP007356', '2026-09', 15),
        customerId: 4517,
        productId: 7356,
        quantityBase: 15,
        conversionValue: 1,
      },
      {
        ...validRow(40, 'KH004517', 'SP007305', '2026-09', 500),
        customerId: 4517,
        productId: 7305,
        quantityBase: 500,
        conversionValue: 1,
      },
      {
        ...validRow(60, 'KH004517', 'SP007356', '2026-09', 15),
        customerId: 4517,
        productId: 7356,
        quantityBase: 15,
        conversionValue: 1,
        note: 'Bổ sung demand tháng 9',
      },
    ];

    const groups = groupCustomerDemandImportRows(rows);
    expect(rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(groups).toHaveLength(1);
    expect(groups[0].customerCode).toBe('KH004517');
    expect(groups[0].voucherIndex).toBe(1);
    expect(groups[0].month).toBe('2026-09');
    expect(groups[0].lines.map((line) => line.productCode)).toEqual([
      'SP007356',
      'SP007305',
      'SP007356',
    ]);
    expect(groups[0].note).toBe('Bổ sung demand tháng 9');
    expect(groups[0].lines.map((line) => line.productCode).sort()).toEqual([
      'SP007305',
      'SP007356',
      'SP007356',
    ]);
    expect(rows[0].voucherIndex).toBe(1);
    expect(rows[2].voucherIndex).toBe(1);
  });

  it('vẫn từ chối dòng thiếu mã hoặc số lượng không hợp lệ', () => {
    const rows = [
      {
        ...validRow(2, 'KH01', 'SP01', '2026-10', 10),
        customerId: 1,
        productId: 11,
        quantityBase: 10,
        conversionValue: 1,
        errors: ['Thiếu mã khách hàng'],
      },
    ];
    expect(groupCustomerDemandImportRows(rows)).toEqual([]);
  });
});

function validRow(
  row: number,
  customerCode: string,
  productCode: string,
  month: string,
  quantity: number,
) {
  return {
    row,
    customerCode,
    customerName: customerCode,
    productCode,
    productName: productCode,
    monthRaw: month,
    quantityRaw: String(quantity),
    unitRaw: 'BASE',
    note: '',
    month,
    quantity,
    unit: 'BASE' as const,
    errors: [] as string[],
    voucherIndex: undefined as number | undefined,
  };
}
