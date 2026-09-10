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

  it('gom nhiều dòng thành phiếu theo khách hàng và báo trùng sản phẩm/tháng', () => {
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
      },
      {
        ...validRow(5, 'KH02', 'SP01', '2026-11', 3),
        customerId: 2,
        productId: 11,
        quantityBase: 3,
        conversionValue: 1,
      },
    ];

    const groups = groupCustomerDemandImportRows(rows);
    expect(rows[2].errors[0]).toMatch(/Trùng sản phẩm SP01/);
    expect(groups).toHaveLength(2);
    expect(groups[0].note).toBe('OEM tháng 10');
    expect(groups[0].months[0].lines).toHaveLength(2);
    expect(groups[1].customerId).toBe(2);
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
  };
}
