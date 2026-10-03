import {
  classifyTable,
  isLarkChecked,
  larkLinkRecordIds,
  mapLarkRecord,
  requiredFieldError,
  readLarkDate,
  selectTablesForSource,
  warehouseCashBranchId,
} from './internal-finance-lark-import.mapper';

const base = {
  baseToken: 'base-finance',
  tableId: 'tblHN0001',
  tableName: 'Tổng hợp phiếu chi kho HN',
  defaultBranchId: 6,
  recordId: 'rec001',
};

describe('Lark finance import mapper', () => {
  it('maps the five source groups to the right category and branch', () => {
    const expense = mapLarkRecord({
      ...base,
      source: 'EXPENSE_HN',
      fields: {
        'Khoản mục': 'Cước gửi hàng cho khách: cước chành xe, ship nội thành',
        'ĐƠN GIÁ': 150000,
        'Số lượng': 2,
        'NỘI DUNG': 'Phí Grab - HD128738',
      },
    }).entry;
    const receipt = mapLarkRecord({
      ...base,
      source: 'RECEIPT',
      defaultBranchId: 1,
      fields: { 'Số tiền': '1.250.000', 'Nội dung thu': 'Thu HD128738' },
    }).entry;
    const advance = mapLarkRecord({
      ...base,
      source: 'SALARY_ADVANCE',
      defaultBranchId: 7,
      fields: { 'Số tiền': 500000 },
    }).entry;
    const fuel = mapLarkRecord({
      ...base,
      source: 'FUEL',
      tableName: 'Kho HN - Xăng dầu',
      defaultBranchId: 6,
      fields: { 'Đơn giá': 20000, 'Số lít': '10', Xe: '51A-123.45' },
    }).entry;
    const care = mapLarkRecord({
      ...base,
      source: 'VEHICLE_CARE',
      tableName: 'Kho SG - Chăm sóc xe',
      defaultBranchId: 1,
      fields: { 'Số tiền': 300000, 'Loại dịch vụ': 'Thay nhớt' },
    }).entry;

    expect(expense).toMatchObject({
      direction: 'EXPENSE',
      category: 'DELIVERY_FEE',
      branchId: 6,
      amount: 300000,
      status: 'PENDING_ACCOUNTANT',
    });
    expect(expense?.invoiceCodes).toEqual(['HD128738']);
    expect(receipt).toMatchObject({
      direction: 'RECEIPT',
      category: 'MANUAL_RECEIPT',
      amount: 1250000,
    });
    expect(advance).toMatchObject({ category: 'SALARY_ADVANCE', branchId: 7 });
    expect(fuel).toMatchObject({
      category: 'FUEL',
      branchId: 6,
      amount: 20000,
    });
    expect(care).toMatchObject({ category: 'VEHICLE_CARE', branchId: 1 });
  });

  it('skips zero amounts and classifies review ticks', () => {
    expect(
      mapLarkRecord({
        ...base,
        source: 'EXPENSE_SG',
        defaultBranchId: 1,
        fields: { 'Số tiền': 0 },
      }).skipReason,
    ).toBe('Số tiền không hợp lệ');

    const approved = mapLarkRecord({
      ...base,
      source: 'EXPENSE_VP',
      tableName: 'Phiếu chi VPSG',
      defaultBranchId: 7,
      fields: {
        'Số tiền': 10,
        'Kế toán kho': true,
        'Quản lý kho': true,
      },
    }).entry;
    const accountantOnly = mapLarkRecord({
      ...base,
      source: 'EXPENSE_VP',
      tableName: 'Phiếu chi VP Hà Nội',
      defaultBranchId: 4,
      fields: { 'Số tiền': 10, 'Kế toán': true },
    }).entry;
    const rejected = mapLarkRecord({
      ...base,
      source: 'EXPENSE_HN',
      fields: { 'Số tiền': 10, 'Trạng thái': 'Từ chối' },
    }).entry;

    expect(approved).toMatchObject({ status: 'APPROVED', branchId: 7 });
    expect(accountantOnly).toMatchObject({
      status: 'ACCOUNTANT_APPROVED',
      branchId: 4,
    });
    expect(rejected?.status).toBe('REJECTED');
  });

  it('keeps a stable idempotency key and ignores the cash rollup table', () => {
    const entry = mapLarkRecord({
      ...base,
      source: 'EXPENSE_HN',
      fields: { 'ĐƠN GIÁ': 10 },
    }).entry;
    expect(entry?.sourceKey).toBe('LARK:base-finance:tblHN0001:rec001');
    expect(entry?.code).toBe('');

    expect(classifyTable('Giao Dịch Tiền Mặt - Kho')).toBe('ROLLUP');
    expect(
      selectTablesForSource('EXPENSE_HN', [
        { tableId: 'rollup', name: 'Giao Dịch Tiền Mặt - Kho' },
        { tableId: 'hn', name: 'Tổng hợp phiếu chi kho HN' },
      ]).map((table) => table.tableId),
    ).toEqual(['hn']);
  });

  it('reads the business date written in the Lark text instead of the import clock time', () => {
    const entry = mapLarkRecord({
      ...base,
      source: 'EXPENSE_HN',
      fields: {
        'Số tiền': 31000,
        'Năm-Tháng': [{ text: '29.09.26 - 31,000 - Phí Grab - HD129495', type: 'text' }],
        'Ngày Tạo': 1790683117000,
      },
    }).entry;
    expect(entry?.occurredAt?.getFullYear()).toBe(2026);
    expect(entry?.occurredAt?.getMonth()).toBe(8);
    expect(entry?.occurredAt?.getDate()).toBe(29);
  });

  it('stops a table when the money field is absent', () => {
    expect(requiredFieldError(['Nội dung', 'Ngày'], 'FUEL')).toMatch(
      /thiếu field số tiền/i,
    );
    expect(requiredFieldError(['Đơn giá'], 'FUEL')).toBeNull();
  });

  it('parses Lark Base Excel serial dates used by Approval lookup fields', () => {
    const date = readLarkDate(45660.70833);
    expect(date?.getUTCFullYear()).toBe(2025);
    expect(date?.getUTCMonth()).toBe(0);
    expect(date?.getUTCDate()).toBe(4);
    const stringDate = readLarkDate("45660.70833");
    expect(stringDate?.getUTCDate()).toBe(4);
  });

  it('selects the real Approval week tables by their configured ids', () => {
    expect(
      selectTablesForSource(
        'APPROVAL_HN',
        [{ tableId: 'tbljYaWkP1tyBjTk', name: 'Approval PHIẾU CHI kho HN' }],
        'tbljYaWkP1tyBjTk',
      ).map((table) => table.tableId),
    ).toEqual(['tbljYaWkP1tyBjTk']);
  });

  it('maps warehouse cash branches and hides link ids behind customer fields', () => {
    expect(warehouseCashBranchId(['Kho Hà Nội'])).toBe(6);
    expect(warehouseCashBranchId(['Kho Sài Gòn'])).toBe(1);
    expect(warehouseCashBranchId(['Văn Phòng Sài Gòn'])).toBeNull();
    expect(larkLinkRecordIds([{ id: 'recCustomer' }])).toEqual(['recCustomer']);
    expect(isLarkChecked(true)).toBe(true);
    expect(isLarkChecked(false)).toBe(false);
  });
});
