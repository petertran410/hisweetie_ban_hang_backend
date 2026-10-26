import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  SESSION_REVOKED,
  SessionRevokedEvent,
  sessionEvents,
} from '../auth/session/session-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORDERS_ALL_ROOM,
  ordersBranchRoom,
  RealtimeGateway,
  sessionRoom,
  userRoom,
} from './realtime.gateway';

export interface OrderChangedPayload {
  orderId: number;
  branchId?: number | null;
  status?: number | null;
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
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

  private readonly onSessionRevoked = (event: SessionRevokedEvent) =>
    this.emitSessionRevoked(event);

  onModuleInit() {
    sessionEvents.on(SESSION_REVOKED, this.onSessionRevoked);
  }

  onModuleDestroy() {
    sessionEvents.off(SESSION_REVOKED, this.onSessionRevoked);
  }

  /**
   * Báo các trình duyệt đang mở của user phải đăng xuất ngay (đổi quyền,
   * đổi mật khẩu, khóa tài khoản). Phiên đã bị thu hồi phía server trước đó.
   */
  emitSessionRevoked(event: SessionRevokedEvent) {
    try {
      const server = this.gateway.server;
      if (!server) return;
      const rooms = [
        ...(event.userIds ?? []).map((id) => userRoom(id)),
        ...(event.sessionIds ?? []).map((id) => sessionRoom(id)),
      ];
      if (rooms.length === 0) return;
      server
        .to(rooms)
        .emit('auth.revoked', { reason: event.reason, at: Date.now() });
    } catch (error) {
      this.logger.warn(
        `emitSessionRevoked failed: ${(error as Error)?.message}`,
      );
    }
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
