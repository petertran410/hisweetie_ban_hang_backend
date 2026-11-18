import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FinanceAccessService,
  type FinanceActor,
} from '../auth/finance-access.service';
import {
  FUND_SOURCE_TYPE,
  InternalFundLedgerService,
} from '../internal-fund/internal-fund-ledger.service';
import { VPSG_FUND_START } from '../approval-lifecycle/approval-lifecycle.constants';
import { VPSG_BRANCH_ID } from '../internal-finance/internal-finance.constants';
import { isVpsgTransaction, vpsgAccountNumbers } from './vpsg-cash.accounts';

const sourceKeyOf = (transactionId: number) =>
  `${FUND_SOURCE_TYPE.SEPAY_VPSG}:${transactionId}`;

const vnDate = (value: Date) =>
  value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Thu tiền mặt Văn phòng SG từ trang Biến động số dư: tiền vào tài khoản VPSG
 * được người có quyền ghi thành một dòng THU trong sổ quỹ nội bộ VPSG. Không
 * tạo phiếu thu, không đụng luồng khách hàng của Sepay.
 */
@Injectable()
export class VpsgCashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: FinanceAccessService,
    private readonly ledger: InternalFundLedgerService,
  ) {}

  private can(user: FinanceActor, action: string) {
    return this.access.can(user, VPSG_BRANCH_ID, `vpsg_cash:${action}`);
  }

  /** Tài khoản VPSG và việc user được làm; không có quyền xem thì rỗng. */
  async accounts(user: FinanceActor) {
    const [view, record, cancel] = await Promise.all([
      this.can(user, 'view'),
      this.can(user, 'record'),
      this.can(user, 'cancel'),
    ]);
    return {
      accountNumbers: view ? await vpsgAccountNumbers(this.prisma) : [],
      canView: view,
      canRecord: view && record,
      canCancel: view && cancel,
      fundStart: VPSG_FUND_START,
    };
  }

  /** Dòng quỹ đã ghi cho các giao dịch đang xem. */
  async records(transactionIds: number[], user: FinanceActor) {
    await this.access.assert(user, VPSG_BRANCH_ID, 'vpsg_cash:view');
    if (!transactionIds.length) return [];
    const rows = await this.prisma.internalFundTransaction.findMany({
      where: {
        sourceKey: { in: transactionIds.map(sourceKeyOf) },
        status: 'POSTED',
      },
      select: {
        id: true,
        code: true,
        sourceId: true,
        amount: true,
        occurredAt: true,
        createdAt: true,
        creator: { select: { id: true, name: true } },
      },
    });
    return rows.map((row) => ({
      transactionId: Number(row.sourceId),
      fundTransactionId: row.id,
      code: row.code,
      amount: row.amount,
      occurredAt: row.occurredAt,
      recordedAt: row.createdAt,
      recordedBy: row.creator,
    }));
  }

  async record(transactionId: number, user: FinanceActor & { id: number }) {
    await this.access.assert(user, VPSG_BRANCH_ID, 'vpsg_cash:view');
    await this.access.assert(user, VPSG_BRANCH_ID, 'vpsg_cash:record');
    const transaction = await this.prisma.sepayTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!transaction) throw new NotFoundException('Không tìm thấy giao dịch');
    const numbers = await vpsgAccountNumbers(this.prisma);
    if (!isVpsgTransaction(transaction, numbers))
      throw new BadRequestException(
        'Giao dịch không thuộc tài khoản quỹ tiền mặt VPSG',
      );
    // Decimal(0).isPositive() là true (số 0 dương), nên so sánh với 0.
    if (!transaction.amountIn.gt(0))
      throw new BadRequestException('Chỉ ghi được giao dịch tiền vào');
    const occurredAt = transaction.transactionDate || transaction.createdAt;
    if (occurredAt < VPSG_FUND_START)
      throw new BadRequestException(
        `Giao dịch trước ngày quỹ VPSG lên POS (${vnDate(VPSG_FUND_START)})`,
      );
    const adjust = await this.access.can(
      user,
      VPSG_BRANCH_ID,
      'internal_fund:adjust',
    );
    return this.prisma.$transaction((tx) =>
      this.ledger.postSystemTransaction(tx, {
        branchId: VPSG_BRANCH_ID,
        transactionType: 'RECEIPT',
        codeKind: 'THU',
        amount: transaction.amountIn,
        occurredAt,
        description:
          transaction.transactionContent?.trim() ||
          transaction.referenceNumber ||
          'Thu từ tài khoản VPSG',
        sourceType: FUND_SOURCE_TYPE.SEPAY_VPSG,
        sourceKey: sourceKeyOf(transaction.id),
        sourceId: String(transaction.id),
        userId: user.id,
        assertOpen: true,
        adjust,
      }),
    );
  }

  async cancel(
    transactionId: number,
    reason: string,
    user: FinanceActor & { id: number },
  ) {
    const text = reason?.trim();
    if (!text) throw new BadRequestException('Cần nhập lý do hủy ghi quỹ');
    await this.access.assert(user, VPSG_BRANCH_ID, 'vpsg_cash:view');
    await this.access.assert(user, VPSG_BRANCH_ID, 'vpsg_cash:cancel');
    const adjust = await this.access.can(
      user,
      VPSG_BRANCH_ID,
      'internal_fund:adjust',
    );
    return this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, [VPSG_BRANCH_ID]);
      const row = await tx.internalFundTransaction.findUnique({
        where: { sourceKey: sourceKeyOf(transactionId) },
      });
      if (!row || row.status !== 'POSTED')
        throw new NotFoundException('Giao dịch chưa ghi vào quỹ VPSG');
      await this.ledger.assertOpen(tx, row.branchId, row.occurredAt, adjust);
      return this.ledger.releaseCancelled(tx, row, user.id, text);
    });
  }
}
