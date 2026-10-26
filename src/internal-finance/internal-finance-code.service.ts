import { Injectable } from '@nestjs/common';
import {
  INTERNAL_FINANCE_BRANCH_CODES,
  INTERNAL_FINANCE_CATEGORY,
  INTERNAL_FINANCE_DIRECTION,
} from './internal-finance.constants';

type DbClient = {
  internalFinanceCodeCounter: {
    upsert: (args: Record<string, unknown>) => Promise<{ nextNumber: number }>;
  };
};

@Injectable()
export class InternalFinanceCodeService {
  async nextCode(
    db: DbClient,
    input: {
      direction: string;
      category: string;
      branchId: number;
      occurredAt: Date;
    },
  ) {
    const dateKey = this.dateKey(input.occurredAt);
    const counter = await db.internalFinanceCodeCounter.upsert({
      where: { dateKey },
      create: { dateKey, nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
      select: { nextNumber: true },
    });
    const sequence = String(counter.nextNumber - 1).padStart(6, '0');
    const branchCode = INTERNAL_FINANCE_BRANCH_CODES[input.branchId] || `B${input.branchId}`;
    const kind = this.kind(input.direction, input.category);
    return `TCNB-${kind}-${branchCode}-${dateKey}-${sequence}`;
  }

  private kind(direction: string, category: string) {
    if (direction === INTERNAL_FINANCE_DIRECTION.RECEIPT) return 'THU';
    if (category === INTERNAL_FINANCE_CATEGORY.FUEL) return 'XD';
    if (category === INTERNAL_FINANCE_CATEGORY.VEHICLE_CARE) return 'CSX';
    if (category === INTERNAL_FINANCE_CATEGORY.SALARY_ADVANCE) return 'TUL';
    return 'CHI';
  }

  private dateKey(value: Date) {
    const vietnamTime = new Date(value.getTime() + 7 * 60 * 60 * 1000);
    const year = vietnamTime.getUTCFullYear();
    const month = String(vietnamTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(vietnamTime.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}
