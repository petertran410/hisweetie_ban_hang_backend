import {
  matchPackingTwins,
  matchVehicleTwins,
  planMerge,
  suspectGroups,
  twinText,
  type TwinEntry,
  type TwinRow,
} from './lark-twin-dedupe';

const at = (iso: string) => new Date(iso);

const dupHn: TwinEntry = {
  id: 1,
  code: 'TCNB-CHI-HN-1',
  branchId: 6,
  amount: 100000,
  occurredAt: at('2026-10-06T17:00:00Z'), // 07/10 giờ VN
  description: '29D - 223.09 - Xăng - Sửa chữa - 2026-10-07',
  note: null,
  sourceSnapshot: {
    lark: { source: 'EXPENSE_HN' },
    fields: { 'Liên Kết Chăm Sóc Xe': [{ text: '29D - 223.09 - Xăng' }] },
  },
};
const careHn: TwinEntry = {
  id: 2,
  code: 'TCNB-CHI-HN-2',
  branchId: 6,
  amount: 100000,
  occurredAt: at('2026-10-07T03:30:00Z'),
  description: 'Sửa chữa - 29D - 223.09 - Xăng',
  note: 'thay ống dẫn xăng',
  sourceSnapshot: {},
  vehicle: { label: '29D - 223.09 - Xăng' },
};

describe('matchVehicleTwins', () => {
  it('pairs the HN expense copy with the vehicle entry via the link text', () => {
    const { pairs, ambiguous } = matchVehicleTwins([dupHn], [careHn]);
    expect(pairs).toEqual([
      { kind: 'vehicle', dup: dupHn, keep: careHn, basis: 'label' },
    ]);
    expect(ambiguous).toEqual([]);
  });

  it('pairs SG copies through the note', () => {
    const dup: TwinEntry = {
      ...dupHn,
      id: 3,
      branchId: 1,
      description: 'Đổ xăng',
      sourceSnapshot: { fields: { 'GHI CHÚ': 'Xe tải 51C-123.45' } },
    };
    const keep: TwinEntry = {
      ...careHn,
      id: 4,
      branchId: 1,
      vehicle: { label: 'Xe tải 51C-123.45' },
    };
    expect(matchVehicleTwins([dup], [keep]).pairs).toHaveLength(1);
  });

  it('does not pair on a different day, amount or vehicle', () => {
    expect(
      matchVehicleTwins(
        [dupHn],
        [{ ...careHn, occurredAt: at('2026-10-08T03:00:00Z') }],
      ).pairs,
    ).toEqual([]);
    expect(
      matchVehicleTwins([dupHn], [{ ...careHn, amount: 120000 }]).pairs,
    ).toEqual([]);
    expect(
      matchVehicleTwins([dupHn], [{ ...careHn, vehicle: { label: '30A-999' } }])
        .pairs,
    ).toEqual([]);
  });

  it('leaves ambiguous matches for manual review', () => {
    const second = { ...careHn, id: 5, code: 'TCNB-CHI-HN-5' };
    const result = matchVehicleTwins([dupHn], [careHn, second]);
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous[0].keeps).toHaveLength(2);
  });

  it('picks the vehicle care entry whose service the copy names', () => {
    const dup: TwinEntry = {
      ...dupHn,
      id: 20,
      description: '29E - 623.55 - Dầu - Phạt nóng - 2026-03-27',
      amount: 1000000,
      sourceSnapshot: {},
    };
    const fuel: TwinEntry = {
      ...careHn,
      id: 21,
      code: 'TCNB-XD-HN-1',
      category: 'FUEL',
      amount: 1000000,
      description: 'Xăng dầu - 29E - 623.55 - Dầu',
      vehicle: { label: '29E - 623.55 - Dầu' },
    };
    const care: TwinEntry = {
      ...fuel,
      id: 22,
      code: 'TCNB-CSX-HN-1',
      category: 'VEHICLE_CARE',
      description: 'Phạt nóng - 29E - 623.55 - Dầu',
    };
    expect(matchVehicleTwins([dup], [fuel, care]).pairs).toEqual([
      { kind: 'vehicle', dup, keep: care, basis: 'label' },
    ]);

    // Bản sao không ghi dịch vụ nào là phiếu xăng.
    const fuelDup: TwinEntry = {
      ...dup,
      id: 23,
      description: 'Dầu xe',
      note: 'Xăng - 29E - 623.55 - Dầu - 2026/03/27',
    };
    expect(matchVehicleTwins([fuelDup], [fuel, care]).pairs).toEqual([
      { kind: 'vehicle', dup: fuelDup, keep: fuel, basis: 'label' },
    ]);
  });

  it('pairs SG care copies without a vehicle name by item and note', () => {
    const dup: TwinEntry = {
      ...dupHn,
      id: 30,
      branchId: 1,
      amount: 180000,
      occurredAt: at('2026-10-11T17:00:00Z'), // 12/10 giờ VN
      description: '12.10.26 - 180,000 - Sửa chữa xe',
      note: 've snnh thắng xe',
      expenseItem: 'Sửa chữa, bảo dưỡng; oto xe máy',
      sourceSnapshot: { lark: { source: 'EXPENSE_SG' } },
    };
    const care: TwinEntry = {
      ...careHn,
      id: 31,
      branchId: 1,
      amount: 180000,
      occurredAt: at('2026-10-12T02:00:00Z'),
      category: 'VEHICLE_CARE',
      description: 'Sửa chữa - 29D - 233.19',
      note: 've snnh thắng xe',
      vehicle: { label: '29D - 233.19' },
    };
    const fuel: TwinEntry = {
      ...care,
      id: 32,
      category: 'FUEL',
      description: 'Xăng dầu - 29D - 233.19',
      note: null,
    };
    expect(matchVehicleTwins([dup], [care, fuel]).pairs).toEqual([
      { kind: 'vehicle', dup, keep: care, basis: 'item' },
    ]);

    // Hai phiếu chăm sóc xe cùng ngày, cùng tiền: ghi chú quyết định.
    const other: TwinEntry = { ...care, id: 33, note: 'thay lốp' };
    expect(matchVehicleTwins([dup], [other, care]).pairs[0].keep).toBe(care);

    // Khoản mục xăng không ghép với phiếu chăm sóc xe.
    const fuelItem: TwinEntry = {
      ...dup,
      id: 34,
      note: null,
      expenseItem: 'Xăng xe: oto, xe tại kho',
    };
    expect(matchVehicleTwins([fuelItem], [care]).pairs).toEqual([]);
  });

  it('reads link and note text without accents', () => {
    expect(twinText(dupHn)).toContain('29d - 223.09 - xang');
  });
});

describe('matchPackingTwins', () => {
  const dup: TwinEntry = {
    ...dupHn,
    id: 10,
    description: 'Phí gửi bến',
    subCategory: 'FEE_GUI_BEN',
    sourceSnapshot: { fields: { 'Mã Báo Đơn': 'BD-30' } },
  };
  const keep: TwinEntry = {
    ...careHn,
    id: 11,
    subCategory: 'FEE_GUI_BEN',
    sourceKey: 'PACKING_SLIP:30:FEE_GUI_BEN',
  };

  it('pairs a Lark row with the POS packing-slip entry by slip code', () => {
    const result = matchPackingTwins(
      [dup],
      new Map([[keep.sourceKey!, keep]]),
      new Map([['BD-30', 30]]),
    );
    expect(result.pairs).toEqual([{ kind: 'packing', dup, keep }]);
  });

  it('reports a different amount instead of merging', () => {
    const result = matchPackingTwins(
      [dup],
      new Map([[keep.sourceKey!, { ...keep, amount: 90000 }]]),
      new Map([['BD-30', 30]]),
    );
    expect(result.pairs).toEqual([]);
    expect(result.mismatched).toHaveLength(1);
  });
});

describe('planMerge', () => {
  const row = (patch: Partial<TwinRow>): TwinRow =>
    ({
      id: 1,
      code: 'X',
      weeklyBatchId: null,
      weeklyBatch: null,
      cashIssued: false,
      cashFlowId: null,
      fundTransaction: null,
      ...patch,
    }) as TwinRow;
  const tx = (id: number) =>
    ({
      id,
      status: 'POSTED',
      amount: 100000,
    }) as unknown as TwinRow['fundTransaction'];

  it('moves the batch and the paid state to the kept entry', () => {
    expect(
      planMerge(
        row({
          weeklyBatchId: 3,
          weeklyBatch: { id: 3, code: 'W40', status: 'APPROVED' },
          cashIssued: true,
          fundTransaction: tx(9),
        }),
        row({ id: 2 }),
      ),
    ).toEqual({ actions: ['moveBatch', 'moveCash'] });
  });

  it('cancels the second fund posting when both were paid', () => {
    expect(
      planMerge(
        row({ cashIssued: true, fundTransaction: tx(9) }),
        row({ id: 2, cashIssued: true, fundTransaction: tx(8) }),
      ),
    ).toEqual({ actions: ['cancelDoubleFund'] });
  });

  it('skips pairs that sit in different weekly batches', () => {
    expect(
      planMerge(
        row({
          weeklyBatchId: 3,
          weeklyBatch: { id: 3, code: 'W40', status: 'READY' },
        }),
        row({
          id: 2,
          weeklyBatchId: 4,
          weeklyBatch: { id: 4, code: 'W41', status: 'READY' },
        }),
      ),
    ).toHaveProperty('skip');
  });
});

describe('suspectGroups', () => {
  const base = {
    branchId: 6,
    amount: 50000 as any,
    occurredAt: at('2026-10-01T03:00:00Z'),
    category: 'OTHER_EXPENSE',
    description: null,
    note: null,
    payer: null,
  };
  it('lists same-day same-amount groups that include a Lark row', () => {
    const rows = [
      { ...base, id: 1, code: 'A', sourceType: 'LARK_IMPORT' },
      { ...base, id: 2, code: 'B', sourceType: 'PACKING_SLIP' },
      { ...base, id: 3, code: 'C', sourceType: 'FUEL', amount: 60000 as any },
      { ...base, id: 4, code: 'D', sourceType: 'MANUAL_EXPENSE', branchId: 1 },
      { ...base, id: 5, code: 'E', sourceType: 'MANUAL_EXPENSE', branchId: 1 },
    ];
    const groups = suspectGroups(rows, new Set());
    expect(groups.map((group) => group.map((row) => row.code))).toEqual([
      ['A', 'B'],
    ]);
    expect(suspectGroups(rows, new Set([1]))).toEqual([]);
  });
});
