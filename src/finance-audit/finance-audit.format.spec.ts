import { Prisma } from '@prisma/client';
import {
  FINANCE_DIFF_FIELDS,
  approvalAuditRef,
  approvalKindLabel,
  branchLabel,
  buildFinanceDiff,
  entryKindLabel,
  formatBoolean,
  formatDate,
  formatMoney,
  fundSourceLabel,
  fundTxnTypeLabel,
  previewText,
  reasonSuffix,
  renderFinanceTemplate,
  reviewDecisionLabel,
  reviewRoleLabel,
  sanitizeAuditJson,
  statusLabel,
} from './finance-audit.format';
import { FINANCE_AUDIT_ENTITY } from './finance-audit.types';

describe('finance audit formatting', () => {
  it('formats money, dates and booleans for Vietnamese display', () => {
    expect(formatMoney(1250000)).toBe('1.250.000 đ');
    expect(formatMoney(new Prisma.Decimal('125000.50'))).toBe('125.000,5 đ');
    expect(formatMoney('2500.00')).toBe('2.500 đ');
    expect(formatMoney(null)).toBe('—');
    // Giờ Việt Nam: 18:00 UTC ngày 5 là ngày 6.
    expect(formatDate(new Date('2026-10-05T18:00:00Z'))).toBe('06/10/2026');
    expect(formatDate('2026-10-05T00:00:00+07:00')).toBe('05/10/2026');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('không phải ngày')).toBe('—');
    expect(formatBoolean(true)).toBe('Có');
    expect(formatBoolean(false)).toBe('Không');
  });

  it('builds reason suffixes, previews and labels', () => {
    expect(reasonSuffix('  ')).toBe('');
    expect(reasonSuffix(null)).toBe('');
    expect(reasonSuffix(' Nhập nhầm ')).toBe(': Nhập nhầm');
    expect(previewText('  một\n  hai   ba ')).toBe('một hai ba');
    expect(previewText('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(entryKindLabel('FUEL')).toBe('phiếu xăng dầu');
    expect(entryKindLabel('MANUAL_RECEIPT')).toBe('phiếu thu tiền mặt');
    expect(entryKindLabel('LẠ')).toBe('phiếu');
    expect(entryKindLabel(null)).toBe('phiếu');
    expect(reviewRoleLabel('manager')).toBe('Quản lý kho');
    expect(reviewRoleLabel('ACCOUNTANT')).toBe('Kế toán kho');
    expect(reviewDecisionLabel('APPROVE')).toBe('duyệt');
    expect(statusLabel(FINANCE_AUDIT_ENTITY.BATCH, 'CANCELLED')).toBe('Đã hủy');
    expect(statusLabel(FINANCE_AUDIT_ENTITY.ENTRY, 'LẠ')).toBe('LẠ');
    expect(fundTxnTypeLabel('TRANSFER_OUT')).toBe('chuyển quỹ đi');
    expect(fundSourceLabel('WAREHOUSE_CASH_RECEIPT')).toBe('tiền mặt kho');
    expect(approvalKindLabel('PAYMENT_VOUCHER')).toBe('PHIẾU CHI');
    expect(branchLabel(6)).toBe('Kho HN');
    expect(branchLabel(99)).toBe('Chi nhánh #99');
  });

  it('replaces EVERY placeholder and blanks missing params', () => {
    expect(
      renderFinanceTemplate(
        '{amount} / {amount} / {totalAmount} / {count} / {missing}.',
        { amount: 1000, totalAmount: '2500.00', count: 3, missing: null },
      ),
    ).toBe('1.000 đ / 1.000 đ / 2.500 đ / 3 / .');
  });

  it('sanitizes nested JSON without throwing on cycles', () => {
    const node: Record<string, unknown> = { a: new Prisma.Decimal('1.5') };
    node.self = node;
    expect(sanitizeAuditJson(node)).toEqual({ a: 1.5, self: '[Circular]' });
    expect(sanitizeAuditJson([undefined, () => 1, Number.NaN])).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('approvalAuditRef', () => {
  it('uses the Lark serial as code and search key, else #id / instance code', () => {
    expect(
      approvalAuditRef({
        id: 10,
        kind: 'RECEIPT',
        instanceCode: 'INS-10',
        detailSnapshot: { serial_number: '202610050001' },
      }),
    ).toEqual({
      code: '202610050001',
      entityCode: '202610050001',
      kindLabel: approvalKindLabel('RECEIPT'),
    });
    expect(
      approvalAuditRef({
        id: 11,
        kind: 'RECEIPT',
        sourceType: 'INTERNAL_FUND_TRANSFER',
        instanceCode: 'INS-11',
        formSnapshot: { metadata: { serialNumber: 202610050002 } },
      }),
    ).toEqual({
      code: '202610050002',
      entityCode: '202610050002',
      kindLabel: approvalKindLabel('TRANSFER'),
    });
    expect(
      approvalAuditRef({ id: 12, kind: 'RECEIPT', clientUuid: 'uuid-12' }),
    ).toMatchObject({ code: '#12', entityCode: 'uuid-12' });
  });
});

describe('buildFinanceDiff whitelists', () => {
  it('covers the required fields per entity type', () => {
    expect(FINANCE_DIFF_FIELDS.internal_finance_entries).toEqual(
      expect.arrayContaining([
        'amount',
        'occurredAt',
        'description',
        'note',
        'payerId',
        'expenseItem',
        'quantity',
        'unitPrice',
        'vehicleName',
        'vehicleOdo',
        'vehicleLiters',
        'vehicleUnitPrice',
        'vehicleLocation',
        'customerId',
        'customerIds',
        'receiptKind',
        'status',
        'confirmedAmount',
        'branchId',
        'evidenceStatus',
        'cancelReason',
      ]),
    );
    expect(FINANCE_DIFF_FIELDS.internal_fund_transactions).toEqual([
      'amount',
      'occurredAt',
      'description',
      'status',
      'branchId',
    ]);
    expect(FINANCE_DIFF_FIELDS.internal_finance_weekly_batches).toEqual([
      'status',
      'totalAmount',
      'cancelReason',
    ]);
    expect(FINANCE_DIFF_FIELDS.internal_fund_transfers).toEqual([
      'status',
      'amount',
    ]);
    expect(FINANCE_DIFF_FIELDS.fuel_advance_entries).toEqual([
      'amount',
      'occurredAt',
      'note',
      'status',
    ]);
    expect(FINANCE_DIFF_FIELDS.internal_fund_daily_closings).toEqual(
      expect.arrayContaining([
        'actualOpeningBalance',
        'actualReceipt',
        'actualExpense',
        'actualClosingBalance',
        'notes',
        'reconciliationStatus',
      ]),
    );
    expect(FINANCE_DIFF_FIELDS.vehicles).toEqual(
      expect.arrayContaining([
        'label',
        'plate',
        'vehicleType',
        'fuelType',
        'isActive',
        'branchId',
        'costPerKmMin',
        'costPerKmMax',
        'oilChangeIntervalKm',
      ]),
    );
  });

  it('diffs entry fields with labels and skips fields missing on either side', () => {
    const changes = buildFinanceDiff(
      FINANCE_AUDIT_ENTITY.ENTRY,
      {
        occurredAt: new Date('2026-10-04T17:00:00Z'),
        evidenceStatus: 'MISSING',
        quantity: new Prisma.Decimal('10.5'),
        vehicleServiceTypes: ['OIL'],
        note: 'cũ',
        branchId: 6,
      },
      {
        occurredAt: new Date('2026-10-05T17:00:00Z'),
        evidenceStatus: 'COMPLETE',
        quantity: 10.5,
        vehicleServiceTypes: ['OIL', 'TIRE'],
        branchId: 1,
      },
    );
    expect(changes.map(({ field, from, to }) => [field, from, to])).toEqual([
      ['occurredAt', '05/10/2026', '06/10/2026'],
      ['vehicleServiceTypes', 'OIL', 'OIL, TIRE'],
      ['branchId', 'Kho HN', 'Kho SG'],
      ['evidenceStatus', 'Thiếu chứng từ', 'Đủ chứng từ'],
    ]);
  });

  it('diffs the warehouse-receipt customer list and kind, not the raw vehicle id', () => {
    const changes = buildFinanceDiff(
      FINANCE_AUDIT_ENTITY.ENTRY,
      {
        customerIds: [12, 34],
        receiptKind: 'CUSTOMER',
        vehicleId: 3,
        vehicleName: 'Xe A',
      },
      {
        customerIds: [12, 56],
        receiptKind: 'WAREHOUSE_SALE',
        vehicleId: 5,
        vehicleName: 'Xe B',
      },
    );
    expect(
      changes.map(({ field, label, from, to }) => [field, label, from, to]),
    ).toEqual([
      ['vehicleName', 'Xe', 'Xe A', 'Xe B'],
      ['customerIds', 'Khách hàng', '#12, #34', '#12, #56'],
      ['receiptKind', 'Loại phiếu', 'Thu khách', 'Bán đồ kho'],
    ]);
  });

  it('labels vehicles, closings and fund transactions', () => {
    expect(
      buildFinanceDiff(
        FINANCE_AUDIT_ENTITY.VEHICLE,
        { isActive: true, vehicleType: 'CAR', fuelType: null, plate: '29A' },
        {
          isActive: false,
          vehicleType: 'MOTORBIKE',
          fuelType: 'DIESEL',
          plate: '29A',
        },
      ).map(({ label, from, to }) => [label, from, to]),
    ).toEqual([
      ['Loại xe', 'Ô tô', 'Xe máy'],
      ['Nhiên liệu', '—', 'Dầu'],
      ['Đang dùng', 'Có', 'Không'],
    ]);
    expect(
      buildFinanceDiff(
        FINANCE_AUDIT_ENTITY.FUND_CLOSING,
        { actualReceipt: null, reconciliationStatus: 'MATCHED' },
        {
          actualReceipt: new Prisma.Decimal('300000'),
          reconciliationStatus: 'PENDING',
        },
      ).map(({ from, to }) => [from, to]),
    ).toEqual([
      ['—', '300.000 đ'],
      ['Khớp', 'Cần đối soát'],
    ]);
    expect(
      buildFinanceDiff(
        FINANCE_AUDIT_ENTITY.FUND_TXN,
        { status: 'POSTED' },
        { status: 'CANCELLED' },
      ),
    ).toEqual([
      {
        field: 'status',
        label: 'Trạng thái',
        from: 'Đã ghi quỹ',
        to: 'Đã hủy',
        type: 'field_changed',
        detail: { from: 'POSTED', to: 'CANCELLED' },
      },
    ]);
  });
});
