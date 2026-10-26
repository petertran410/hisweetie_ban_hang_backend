import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORDERS_ALL_ROOM,
  ordersBranchRoom,
  RealtimeGateway,
} from './realtime.gateway';

export interface OrderChangedPayload {
  orderId: number;
  branchId?: number | null;
  status?: number | null;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Báo đơn hàng vừa thay đổi — CHỈ tới user có quyền xem đơn của chi nhánh
   * đó (và Super Admin). Payload tối thiểu; client tự refetch qua API có
   * phân quyền. Gọi SAU khi transaction commit. Không bao giờ ném lỗi.
   */
  emitOrderChanged(payload: OrderChangedPayload) {
    void this.emitOrderChangedAsync(payload);
  }

  private async emitOrderChangedAsync(payload: OrderChangedPayload) {
    try {
      const server = this.gateway.server;
      if (!server) return;

      let branchId = payload.branchId ?? null;
      if (branchId == null) {
        const order = await this.prisma.order.findUnique({
          where: { id: payload.orderId },
          select: { branchId: true },
        });
        branchId = order?.branchId ?? null;
      }

      const rooms = [ORDERS_ALL_ROOM];
      if (branchId != null) rooms.push(ordersBranchRoom(branchId));

      server.to(rooms).emit('order.changed', {
        orderId: payload.orderId,
        branchId,
        status: payload.status ?? null,
        at: Date.now(),
      });
    } catch (error) {
      this.logger.warn(
        `emitOrderChanged failed for order ${payload.orderId}: ${
          (error as Error)?.message
        }`,
      );
    }
  }
}
