import {
  mapLarkWeekRow,
  matchVehicle,
  type LarkWeekRow,
} from './approved-week-fix';

describe('approved-week-fix', () => {
  it('reads a Lark expense row with week, year and ticks', () => {
    expect(
      mapLarkWeekRow({
        recordId: 'r1',
        fields: {
          'NĂM/THÁNG/NGÀY': 1789225371000,
          'THÀNH TIỀN': { type: 2, value: [1500000] },
          Tuần: { type: 2, value: [37] },
          Năm: ['optN0YH28M'],
          'NỘI DUNG': [{ text: 'Dầu xe', type: 'text' }],
          'GHI CHÚ': [
            { text: 'Xăng - 29K - 053.80 - 2026/09/12', type: 'text' },
          ],
          'Quản Lý Kho': true,
          'Kế Toán Kho': false,
        },
      }),
    ).toMatchObject({
      week: 37,
      year: 2026,
      amount: 1500000,
      managerChecked: true,
      accountantChecked: false,
    });
  });

  it('matches the vehicle entry POS kept by exact time, then by plate', () => {
    const at = new Date('2026-09-12T08:22:51Z');
    const row: LarkWeekRow = {
      recordId: 'r1',
      ms: at.getTime(),
      day: '2026-09-12',
      amount: 500000,
      week: 37,
      year: 2026,
      content: 'Dầu xe',
      note: 'Xăng - 29K - 053.80 - 2026/09/12',
      managerChecked: false,
      accountantChecked: false,
    };
    const vehicle = (id: number, label: string, time: Date) =>
      ({
        id,
        amount: 500000,
        occurredAt: time,
        description: `Xăng dầu - ${label}`,
      }) as any;
    const exact = vehicle(1, '30B - 460.35 - Xăng', at);
    const other = vehicle(
      2,
      '29K - 053.80 - Dầu',
      new Date('2026-09-12T02:00:00Z'),
    );
    expect(matchVehicle(row, [other, exact], new Set())).toBe(exact);
    expect(matchVehicle({ ...row, ms: null }, [other, exact], new Set())).toBe(
      other,
    );
    expect(
      matchVehicle({ ...row, ms: null }, [other, exact], new Set([2])),
    ).toBeNull();
  });
});
