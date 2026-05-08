import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function recalcCustomerDebt(targetCustomerId: number) {
  return prisma.$transaction(async (tx) => {
    const childIds = await tx.customer.findMany({
      where: { id: targetCustomerId },
      select: { id: true },
    });
    const allCustomerIds = [targetCustomerId, ...childIds.map((c) => c.id)];

    const invoices = await tx.invoice.findMany({
      where: {
        customerId: { in: allCustomerIds },
        status: { notIn: [2] },
      },
      select: { grandTotal: true },
    });
    const totalGrandTotal = invoices.reduce(
      (sum, inv) => sum + Number(inv.grandTotal),
      0,
    );
    const totalPurchased = totalGrandTotal;

    const cashFlowsReceipt = await tx.cashFlow.findMany({
      where: {
        partnerId: { in: allCustomerIds },
        partnerType: 'C',
        isReceipt: true,
        status: { not: 2 },
        NOT: [
          { code: { startsWith: 'TTTUHD' } },
          { code: { startsWith: 'CB' } },
        ],
      },
      select: { amount: true },
    });
    const totalCashFlowReceived = cashFlowsReceipt.reduce(
      (sum, cf) => sum + Number(cf.amount),
      0,
    );

    const cashFlowsPaidOut = await tx.cashFlow.findMany({
      where: {
        partnerId: { in: allCustomerIds },
        partnerType: 'C',
        isReceipt: false,
        status: { not: 2 },
      },
      select: { amount: true },
    });
    const totalCashFlowPaidOut = cashFlowsPaidOut.reduce(
      (sum, cf) => sum + Number(cf.amount),
      0,
    );

    const debtOffsets = await tx.returnOrder.findMany({
      where: {
        customerId: { in: allCustomerIds },
        OR: [
          { status: 2 },
          { status: 4, refundType: 'debt_offset' },
          { status: 4, refundType: 'cash_refund' },
        ],
      },
      select: { refundAmount: true },
    });
    const totalDebtOffsets = debtOffsets.reduce(
      (sum, ro) => sum + Number(ro.refundAmount),
      0,
    );

    const totalDebt =
      totalGrandTotal -
      totalCashFlowReceived +
      totalCashFlowPaidOut -
      totalDebtOffsets;

    await tx.customer.update({
      where: { id: targetCustomerId },
      data: { totalPurchased, totalDebt },
    });

    if (childIds.length > 0) {
      await tx.customer.updateMany({
        where: { id: { in: childIds.map((c) => c.id) } },
        data: { totalDebt: 0, totalPurchased: 0 },
      });
    }

    return totalDebt;
  });
}

async function main() {
  const parents = await prisma.customer.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
  });

  console.log(`Recalc ${parents.length} customers...`);

  for (const c of parents) {
    try {
      const newDebt = await recalcCustomerDebt(c.id);
      console.log(`✓ ${c.code} - ${c.name}: ${newDebt}`);
    } catch (err) {
      console.error(`✗ ${c.code}:`, err);
    }
  }

  console.log('Done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
