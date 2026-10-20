import { Prisma } from '@prisma/client';
import {
  exportDate,
  warehouseExpenseExportColumns,
  warehouseExpenseExportRow,
  type WarehouseExpenseExportEntry,
} from './warehouse-expense-export';

const entry = (
  patch: Partial<WarehouseExpenseExportEntry> = {},
): WarehouseExpenseExportEntry => ({
  id: 1,
  code: 'TCNB-CHI-SG-20261013-000034',
  branchId: 1,
  occurredAt: new Date('2026-10-13T03:30:00Z'),
  sourceType: 'PACKING_SLIP',
  sourceSnapshot: {},
  category: 'DELIVERY_FEE',
  subCategory: 'FEE_GUI_BEN',
  description: 'FEE_GUI_BEN - Chị Lan - HD001',
  note: null,
  expenseItem: null,
  quantity: null,
  unitPrice: null,
  amount: new Prisma.Decimal(20000),
  status: 'PENDING_ACCOUNTANT',
  cancelReason: null,
  cashIssued: false,
  cashIssuedReason: null,
  vehicleName: null,
  managerReviewedAt: null,
  accountantReviewedAt: null,
  branch: { name: 'Kho SG' },
  payer: { name: 'An' },
  creator: { name: 'Bình' },
  managerReviewer: null,
  accountantReviewer: null,
  vehicle: null,
  packingSlip: { code: 'BD016053' },
  fundTransaction: null,
  weeklyBatch: null,
  attachments: [],
  ...patch,
});

describe('warehouse-expense-export', () => {
  it('maps a packing-slip fee like the table', () => {
    const { row, dateHasTime } = warehouseExpenseExportRow(entry(), 3);
    expect(row).toMatchObject({
      stt: 3,
      branch: 'Kho SG',
      source: 'Báo đơn giao hàng',
      reference: 'BD016053',
      description: 'Phí gửi bến - Chị Lan - HD001',
      item: 'Phí gửi bến',
      group: 'Phí gửi bến',
      payer: 'An',
      amount: 20000,
      batch: 'Chưa tổng hợp',
      approvalStatus: 'Chưa gửi',
      cashIssued: 'Chưa chi',
      cancelled: '',
    });
    // Giờ VN: 03:30Z = 10:30 ngày 13/10.
    expect(dateHasTime).toBe(true);
    expect((row.date as Date).toISOString()).toBe('2026-10-13T10:30:00.000Z');
  });

  it('uses the Lark business date, date only', () => {
    const date = exportDate({
      occurredAt: new Date('2026-10-12T17:00:00Z'),
      sourceType: 'LARK_IMPORT',
      sourceSnapshot: { fields: { 'Ngày chi': [{ text: '28/09/2026' }] } },
    });
    expect(date.hasTime).toBe(false);
    expect(date.value.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    // Không có ngày trong dữ liệu Lark: lấy ngày VN của occurredAt.
    const fallback = exportDate({
      occurredAt: new Date('2026-10-12T17:00:00Z'),
      sourceType: 'LARK_IMPORT',
      sourceSnapshot: {},
    });
    expect(fallback.value.toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('shows cancel reason, issued fund code, ticks and approval status', () => {
    const { row } = warehouseExpenseExportRow(
      entry({
        status: 'CANCELLED',
        cancelReason: 'Trùng phiếu',
        cashIssued: true,
        cashIssuedReason: 'Chi ngoài tuần',
        managerReviewedAt: new Date('2026-10-14T02:00:00Z'),
        managerReviewer: { name: 'Quản lý' },
        fundTransaction: { code: 'QF-CHI-9', status: 'CANCELLED' },
        weeklyBatch: {
          code: 'TCNB-TUAN-SG-2026-W42',
          approvalRequest: { status: 'PENDING' },
        },
      }),
      1,
    );
    expect(row).toMatchObject({
      cancelled: 'Đã hủy: Trùng phiếu',
      cashIssued: 'Đã chi',
      fundCode: 'QF-CHI-9 (đã hủy)',
      cashIssuedReason: 'Chi ngoài tuần',
      batch: 'TCNB-TUAN-SG-2026-W42',
      approvalStatus: 'Đang duyệt',
      accountant: '',
    });
    expect(String(row.manager)).toMatch(/^Quản lý · /);
  });

  it('links each attachment in its own column', () => {
    const { row } = warehouseExpenseExportRow(
      entry({
        attachments: [
          {
            fileUrl: 'https://cdn.example.com/a/bien-lai.jpg?x=1',
            fileName: null,
          },
          { fileUrl: 'https://cdn.example.com/b.pdf', fileName: 'Hóa đơn' },
        ],
      }),
      1,
    );
    expect(row.attachmentCount).toBe(2);
    expect(row.file1).toEqual({
      text: 'bien-lai.jpg',
      hyperlink: 'https://cdn.example.com/a/bien-lai.jpg?x=1',
    });
    expect(row.file2).toEqual({
      text: 'Hóa đơn',
      hyperlink: 'https://cdn.example.com/b.pdf',
    });
    const keys = warehouseExpenseExportColumns(2).map((column) => column.key);
    expect(keys.slice(-2)).toEqual(['file1', 'file2']);
  });
});
