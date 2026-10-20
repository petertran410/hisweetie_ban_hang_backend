import {
  advanceUsage,
  isCoverableExpense,
  planCoverage,
  type CoverageAdvance,
  type CoverageExpense,
} from './cash-advance-coverage';

const M = 1_000_000 * 100; // 1 triệu (xu)

const advance = (
  id: number,
  amount: number,
  from: string,
  to: string,
  extra: Partial<CoverageAdvance> = {},
): CoverageAdvance => ({
  id,
  code: `TU-${id}`,
  orderAt: new Date(`${from}T0${id}:00:00Z`),
  fromKey: from,
  toKey: to,
  amountCents: amount,
  refundedCents: 0,
  lockedCents: 0,
  ...extra,
});

let nextId = 1;
const expense = (
  day: string,
  amount: number,
  id = nextId++,
): CoverageExpense => ({
  id,
  dayKey: day,
  occurredAt: new Date(`${day}T03:00:00Z`),
  amountCents: amount,
});

describe('planCoverage', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('fills one advance in date order and leaves the overflow uncovered', () => {
    const plan = planCoverage(
      [advance(1, 5 * M, '2026-10-19', '2026-10-25')],
      [
        expense('2026-10-21', 3 * M, 2),
        expense('2026-10-20', 1 * M, 1),
        expense('2026-10-22', 2 * M, 3),
      ],
    );
    expect(plan.projectedByAdvance.get(1)).toBe(5 * M);
    expect(plan.parts).toEqual([
      { entryId: 1, advanceId: 1, cents: 1 * M },
      { entryId: 2, advanceId: 1, cents: 3 * M },
      { entryId: 3, advanceId: 1, cents: 1 * M },
    ]);
    expect(plan.uncovered.get(3)).toBe(1 * M);
  });

  it('rolls into the next advance when the first is full (A 50tr → B)', () => {
    // A ứng 50tr cho 19–25/10; 22/10 ứng thêm B để phòng thiếu.
    const a = advance(1, 50 * M, '2026-10-19', '2026-10-25');
    const b = advance(2, 30 * M, '2026-10-22', '2026-10-25', {
      orderAt: new Date('2026-10-22T02:00:00Z'),
    });
    const plan = planCoverage(
      [b, a],
      [
        expense('2026-10-19', 20 * M),
        expense('2026-10-21', 25 * M),
        // Phiếu này chia đôi: 5tr vào A, 7tr vào B.
        expense('2026-10-23', 12 * M),
        expense('2026-10-24', 10 * M),
      ],
    );
    expect(plan.projectedByAdvance.get(1)).toBe(50 * M);
    expect(plan.projectedByAdvance.get(2)).toBe(17 * M);
    expect(plan.parts.filter((part) => part.entryId === 3)).toEqual([
      { entryId: 3, advanceId: 1, cents: 5 * M },
      { entryId: 3, advanceId: 2, cents: 7 * M },
    ]);
    expect(plan.uncovered.size).toBe(0);
  });

  it('does not let an expense before B’s period use B', () => {
    const plan = planCoverage(
      [
        advance(1, 10 * M, '2026-10-19', '2026-10-25'),
        advance(2, 30 * M, '2026-10-22', '2026-10-25'),
      ],
      [expense('2026-10-20', 15 * M)],
    );
    expect(plan.projectedByAdvance.get(1)).toBe(10 * M);
    expect(plan.projectedByAdvance.get(2)).toBe(0);
    expect(plan.uncovered.get(1)).toBe(5 * M);
  });

  it('only projects into the room left after locked parts and refunds', () => {
    const plan = planCoverage(
      [
        advance(1, 10 * M, '2026-10-19', '2026-10-25', {
          lockedCents: 6 * M,
          refundedCents: 1 * M,
        }),
      ],
      // Phiếu nhập lùi ngày chỉ làm đổi phần dự kiến, phần đã chốt giữ nguyên.
      [expense('2026-10-19', 5 * M)],
    );
    expect(plan.projectedByAdvance.get(1)).toBe(3 * M);
    expect(plan.uncovered.get(1)).toBe(2 * M);
  });

  it('breaks ties by advance order then id', () => {
    const at = new Date('2026-10-19T01:00:00Z');
    const plan = planCoverage(
      [
        advance(2, 5 * M, '2026-10-19', '2026-10-25', { orderAt: at }),
        advance(1, 5 * M, '2026-10-19', '2026-10-25', { orderAt: at }),
      ],
      [expense('2026-10-20', 6 * M)],
    );
    expect(plan.parts.map((part) => part.advanceId)).toEqual([1, 2]);
  });
});

describe('advanceUsage', () => {
  it('splits used into locked + projected and suggests the refund', () => {
    const coverage = {
      advances: [
        advance(1, 50 * M, '2026-10-19', '2026-10-25', {
          lockedCents: 20 * M,
          refundedCents: 0,
        }),
      ],
      expenses: [],
      plan: {
        parts: [],
        uncovered: new Map(),
        projectedByAdvance: new Map([[1, 10 * M]]),
      },
    };
    expect(
      advanceUsage(
        { id: 1, amount: 50_000_000, status: 'CONFIRMING' },
        coverage,
      ),
    ).toEqual({
      amount: 50_000_000,
      refunded: 0,
      locked: 20_000_000,
      projected: 10_000_000,
      used: 30_000_000,
      remaining: 20_000_000,
      maxRefund: 30_000_000,
      suggestedRefund: 20_000_000,
    });
  });

  it('reports nothing used for a draft advance', () => {
    expect(
      advanceUsage({ id: 9, amount: 1_000_000, status: 'DRAFT' }, null),
    ).toMatchObject({ used: 0, remaining: 1_000_000 });
  });
});

describe('isCoverableExpense', () => {
  const base = {
    direction: 'EXPENSE',
    branchId: 6,
    category: 'DELIVERY_FEE',
    status: 'PENDING_ACCOUNTANT',
    cashFlowId: null,
    sourceSnapshot: {},
  };

  it.each([
    ['a warehouse expense', {}, true],
    ['a VP branch', { branchId: 4 }, false],
    ['a cancelled entry', { status: 'CANCELLED' }, false],
    ['a rejected entry', { status: 'REJECTED' }, false],
    ['a receipt', { direction: 'RECEIPT' }, false],
    ['salary advance', { category: 'SALARY_ADVANCE' }, false],
    ['a CashFlow-linked entry', { cashFlowId: 3 }, false],
    [
      'a Lark-ledger entry',
      { sourceSnapshot: { larkLedgerRecorded: true } },
      false,
    ],
  ])('%s → %s', (_label, patch, expected) => {
    expect(isCoverableExpense({ ...base, ...patch })).toBe(expected);
  });
});
