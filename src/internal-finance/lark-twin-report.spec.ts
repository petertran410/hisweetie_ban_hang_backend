import { Prisma } from '@prisma/client';
import { buildTwinReport } from './lark-twin-report';
import type { TwinPlan } from './lark-twin-dedupe';

const row = (patch: Record<string, unknown>) =>
  ({
    id: 1,
    code: 'X',
    branchId: 6,
    amount: new Prisma.Decimal(100000),
    occurredAt: new Date('2026-10-07T03:00:00Z'),
    description: 'Mô tả',
    note: null,
    weeklyBatch: null,
    fundTransaction: null,
    ...patch,
  }) as any;

describe('buildTwinReport', () => {
  const plan = {
    merges: [
      {
        kind: 'vehicle',
        basis: 'item',
        dup: row({ id: 1, code: 'CHI-1', branchId: 1 }),
        keep: row({ id: 2, code: 'CSX-1', branchId: 1 }),
        actions: ['moveCash'],
      },
    ],
    skipped: [],
    ambiguous: [
      { dup: row({ id: 3, code: 'CHI-3' }), keeps: [row({ code: 'XD-1' })] },
    ],
    plateMissing: [],
    packingMismatched: [],
    suspects: [
      [
        row({
          id: 4,
          code: 'CHI-4',
          sourceType: 'LARK_IMPORT',
          category: 'OTHER_EXPENSE',
          payer: null,
        }),
        row({
          id: 5,
          code: 'BD-5',
          sourceType: 'PACKING_SLIP',
          category: 'DELIVERY_FEE',
          payer: { name: 'An' },
        }),
      ],
    ],
  } as unknown as TwinPlan;

  it('keeps the terminal summary short and puts details in sheets', () => {
    const report = buildTwinReport(
      plan,
      new Map([
        [6, 1000000],
        [1, 500000],
      ]),
    );
    expect(report.summary.length).toBeLessThan(20);
    expect(report.summary.join('\n')).toContain('khoản mục xe 1');
    expect(report.summary.join('\n')).toContain('Cần kiểm tay: 1 dòng');
    expect(report.summary.join('\n')).toContain('1 nhóm, 2 phiếu');

    const [, merged, manual, suspects] = report.sheets;
    expect(merged.rows[0]).toMatchObject({
      branch: 'Kho SG',
      date: '2026-10-07',
      amount: 100000,
      basis: 'Khoản mục xe',
      dupCode: 'CHI-1',
      keepCode: 'CSX-1',
    });
    expect(manual.rows[0]).toMatchObject({
      code: 'CHI-3',
      reason: 'Khớp nhiều phiếu xe',
      candidates: 'XD-1',
    });
    expect(suspects.rows.map((r) => [r.group, r.code])).toEqual([
      [1, 'CHI-4'],
      [1, 'BD-5'],
    ]);
  });
});
