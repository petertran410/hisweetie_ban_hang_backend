import { BadRequestException } from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LarkProductSyncService } from '../lark-sync/services/lark-product-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfirmStockReceivedDto } from './dto';
import { ReturnOrdersService } from './return-orders.service';

describe('ReturnOrdersService', () => {
  describe('confirmStockReceived', () => {
    it('locks the return order before reading it and rejects a received order', async () => {
      const callOrder: string[] = [];
      const tx = {
        $queryRaw: jest.fn(() => {
          callOrder.push('lock');
          return Promise.resolve([{ id: 10 }]);
        }),
        returnOrder: {
          findUnique: jest.fn(() => {
            callOrder.push('findUnique');
            return Promise.resolve({
              id: 10,
              status: 2,
              branchId: 1,
            });
          }),
        },
      };
      const prisma = {
        $transaction: jest.fn((callback: (txClient: typeof tx) => unknown) =>
          Promise.resolve().then(() => callback(tx)),
        ),
      };
      const service = new ReturnOrdersService(
        prisma as unknown as PrismaService,
        {} as unknown as AuditLogsService,
        {} as unknown as LarkProductSyncService,
      );

      await expect(
        service.confirmStockReceived(
          10,
          { details: [] } as unknown as ConfirmStockReceivedDto,
          1,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(callOrder).toEqual(['lock', 'findUnique']);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 15_000,
      });
    });
  });
});
