import {
  matchPackingTwins,
  matchVehicleTwins,
  planMerge,
  plateHints,
  suspectGroups,
  vehiclePlate,
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
      { kind: 'vehicle', dup: dupHn, keep: careHn, basis: 'plate' },
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
      { kind: 'vehicle', dup, keep: care, basis: 'plate' },
    ]);

    // Bản sao không ghi dịch vụ nào là phiếu xăng.
    const fuelDup: TwinEntry = {
      ...dup,
      id: 23,
      description: 'Dầu xe',
      note: 'Xăng - 29E - 623.55 - Dầu - 2026/03/27',
    };
    expect(matchVehicleTwins([fuelDup], [fuel, care]).pairs).toEqual([
      { kind: 'vehicle', dup: fuelDup, keep: fuel, basis: 'plate' },
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

describe('plate matching', () => {
  it('reads plate hints and ignores dates and amounts', () => {
    expect(plateHints('Xăng - 29D - 220.60 - 2026/03/09')).toEqual(
      expect.arrayContaining(['29d22060', '22060']),
    );
    expect(plateHints('Dầu xe 053.80')).toEqual(['05380']);
    expect(plateHints('Sửa xe 2309')).toEqual(['2309']);
    expect(plateHints('XE TIỀN 52218')).toEqual(['52218']);
    expect(plateHints('12.10.26 - 180,000 - Sửa chữa xe')).toEqual([]);
    expect(plateHints('Xăng - 71H4 - 8700 (xe máy) - 2026/10/14')).toEqual(
      expect.arrayContaining(['71h48700']),
    );
    expect(
      vehiclePlate({ ...careHn, vehicle: { label: '71H4 - 8700 (xe máy)' } }),
    ).toBe('71h48700');
    expect(
      vehiclePlate({ ...careHn, vehicle: { label: '29D - 220.60 - Xăng' } }),
    ).toBe('29d22060');
  });

  const day = at('2026-03-09T03:00:00Z');
  const fuel = (id: number, label: string): TwinEntry => ({
    ...careHn,
    id,
    code: `XD-${id}`,
    category: 'FUEL',
    amount: 650000,
    occurredAt: day,
    description: `Xăng dầu - ${label}`,
    note: null,
    vehicle: { label },
  });
  const copy = (id: number, note: string, item?: string): TwinEntry => ({
    ...dupHn,
    id,
    amount: 650000,
    occurredAt: day,
    description: 'Dầu xe',
    note,
    expenseItem: item ?? 'Xăng xe: oto, xe tại kho',
    sourceSnapshot: {},
  });

  it('pairs only with the vehicle whose plate the copy names', () => {
    const right = fuel(41, '29D - 220.60 - Xăng');
    const wrong = fuel(42, '30B - 460.35 - Xăng');
    const dup = copy(40, 'Xăng - 29D - 220.60 - 2026/03/09');
    expect(matchVehicleTwins([dup], [wrong, right]).pairs).toEqual([
      { kind: 'vehicle', dup, keep: right, basis: 'plate' },
    ]);
  });

  it('pairs by identical timestamp even when the vehicle was renamed later', () => {
    const at09 = at('2026-03-09T10:26:52Z');
    const renamed = { ...fuel(51, '30B - 460.35 - Xăng'), occurredAt: at09 };
    const other = fuel(52, '29D - 223.09 - Xăng');
    const dup = {
      ...copy(53, 'Xăng - 29D - 220.60 - 2026/03/09'),
      occurredAt: at09,
    };
    expect(matchVehicleTwins([dup], [other, renamed]).pairs).toEqual([
      { kind: 'vehicle', dup, keep: renamed, basis: 'time' },
    ]);
  });

  it('reports a copy naming a plate that has no matching entry that day', () => {
    const dup = copy(43, 'Xăng - 29D - 220.60 - 2026/03/09');
    // Phiếu xe khác giờ: không phải bản gốc của bản sao này.
    const result = matchVehicleTwins(
      [dup],
      [
        {
          ...fuel(44, '30B - 460.35 - Xăng'),
          occurredAt: at('2026-03-09T05:00:00Z'),
        },
      ],
    );
    expect(result.pairs).toEqual([]);
    expect(result.plateMissing[0].hints).toContain('29d22060');
  });

  it('matches short plate hints like "053.80" and "2309"', () => {
    const dup = copy(45, 'Dầu xe 053.80');
    const keep = fuel(46, '29K - 053.80 - Dầu');
    expect(
      matchVehicleTwins([dup], [fuel(47, '29E - 623.55 - Dầu'), keep]).pairs[0]
        .keep,
    ).toBe(keep);
  });

  it('sends a copy without plate to manual review when two vehicles match', () => {
    const dup = copy(48, '');
    const result = matchVehicleTwins(
      [dup],
      [fuel(49, '29D - 220.60 - Xăng'), fuel(50, '30B - 460.35 - Xăng')],
    );
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous[0].keeps).toHaveLength(2);
  });
});

describe('suspectGroups', () => {
  const base = {
    branchId: 6,
    amount: 50000 as any,
    occurredAt: at('2026-10-01T03:00:00Z'),
    description: null,
    note: null,
    payer: null,
    sourceSnapshot: {},
  };
  const gửiBến = {
    ...base,
    id: 1,
    code: 'CHI-1',
    sourceType: 'LARK_IMPORT',
    category: 'DELIVERY_FEE',
    description: 'Phí gửi bến - HD1',
    expenseItem: 'Cước gửi hàng cho khách',
  };
  const xăngCopy = {
    ...base,
    id: 2,
    code: 'CHI-2',
    sourceType: 'LARK_IMPORT',
    category: 'OTHER_EXPENSE',
    expenseItem: 'Xăng xe: oto, xe tại kho',
  };
  const xăng = {
    ...base,
    id: 3,
    code: 'XD-3',
    sourceType: 'LARK_IMPORT',
    category: 'FUEL',
    vehicle: { label: '29D - 220.60 - Xăng' },
  };

  it('groups a vehicle-like copy only with vehicle entries', () => {
    const groups = suspectGroups(
      [gửiBến, xăngCopy] as any,
      [xăng] as any,
      [],
      new Set(),
    );
    expect(groups.map((g: any[]) => g.map((row) => row.code))).toEqual([
      ['CHI-2', 'XD-3'],
    ]);
  });

  it('skips copies already merged or under manual review', () => {
    expect(
      suspectGroups([xăngCopy] as any, [xăng] as any, [], new Set([2])),
    ).toEqual([]);
  });
});
