import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { isCorsOriginAllowed } from '../common/cors-origin.util';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';

const SUPER_ADMIN_ROLE = 'Super Admin';
const ORDER_VIEW_PERMISSION = 'orders:view';

/** Kiểm tra lại tài khoản/quyền định kỳ (khóa tài khoản, đổi quyền, đổi chi nhánh). */
const REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;
/** Giới hạn số kết nối đồng thời của 1 user (nhiều tab/máy). */
const MAX_SOCKETS_PER_USER = 20;

export const ORDERS_ALL_ROOM = 'orders:all';
export const ordersBranchRoom = (branchId: number) =>
  `orders:branch:${branchId}`;
/** Phòng riêng của từng user — dùng để buộc đăng xuất ngay. */
export const userRoom = (userId: number) => `user:${userId}`;

interface AccessTokenPayload {
  sub?: number;
  typ?: string;
  exp?: number;
}

interface ValidatedUser {
  id: number;
  roles?: string[];
  permissions?: string[];
  branchIds?: number[];
}

interface SocketData {
  userId?: number;
  token?: string;
  user?: ValidatedUser;
  expiryTimer?: ReturnType<typeof setTimeout>;
  revalidateTimer?: ReturnType<typeof setInterval>;
}

class SocketAuthError extends Error {}

/**
 * Gateway chỉ đẩy sự kiện server → client (không có @SubscribeMessage),
 * nên client không gửi được lệnh nào lên server.
 *
 * Bảo mật:
 * - Origin: chặn ở `allowRequest` cho CẢ polling lẫn WebSocket upgrade
 *   (WebSocket không bị trình duyệt kiểm tra CORS).
 * - Xác thực: access token trong `handshake.auth.token` (không qua URL),
 *   verify chữ ký + hạn, rồi chạy lại JwtStrategy.validate (tài khoản còn
 *   hoạt động, permissionVersion khớp) — giống hệt HTTP.
 * - Phân quyền: chỉ vào phòng của chi nhánh mà user có quyền `orders:view`.
 * - Tự ngắt khi token hết hạn; kiểm tra lại định kỳ mỗi 5 phút.
 */
@WebSocketGateway({
  cors: {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => callback(null, isCorsOriginAllowed(origin)),
    credentials: true,
  },
  allowRequest: (req: { headers: { origin?: string } }, fn) => {
    const allowed = isCorsOriginAllowed(req.headers.origin);
    fn(allowed ? null : 'origin not allowed', allowed);
  },
  // Client không gửi dữ liệu lên → giới hạn gói tin nhỏ.
  maxHttpBufferSize: 10_000,
  connectTimeout: 10_000,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly jwtStrategy: JwtStrategy,
    private readonly authService: AuthService,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  afterInit(server: Server) {
    // Middleware chạy TRƯỚC khi kết nối được thiết lập: sai token → client
    // nhận connect_error, không bao giờ vào được phòng nào.
    server.use((socket, next) => {
      this.authenticate(socket)
        .then(() => next())
        .catch((error: unknown) => {
          if (!(error instanceof SocketAuthError)) {
            this.logger.warn(
              `Socket auth error: ${(error as Error)?.message ?? error}`,
            );
          }
          next(new Error('unauthorized'));
        });
    });
  }

  /** Chỉ chạy khi middleware xác thực đã cho qua. */
  async handleConnection(client: Socket) {
    const data = client.data as SocketData;
    if (!data.user || !data.token) {
      client.disconnect(true);
      return;
    }
    try {
      await this.syncRooms(client, data.user);
    } catch {
      client.disconnect(true);
      return;
    }
    this.scheduleExpiry(client, data.token);
    data.revalidateTimer = setInterval(() => {
      void this.revalidate(client);
    }, REVALIDATE_INTERVAL_MS);
  }

  handleDisconnect(client: Socket) {
    this.clearTimers(client);
  }

  private async authenticate(socket: Socket) {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token = typeof auth?.token === 'string' ? auth.token : undefined;
    if (!token) throw new SocketAuthError('missing token');

    const user = await this.validateToken(token);
    const data = socket.data as SocketData;
    data.userId = user.id;
    data.token = token;
    data.user = user;

    await this.enforceSocketLimit(user.id);
  }

  /** Verify chữ ký + hạn token, rồi kiểm tra tài khoản như HTTP. */
  private async validateToken(token: string): Promise<ValidatedUser> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new SocketAuthError('invalid token');
    }
    // Giống JwtStrategy: token định dạng cũ (không có `typ`) vẫn hợp lệ;
    // token khác ký cùng secret (Lark state/setup...) luôn có `typ` riêng.
    if (
      !payload?.sub ||
      (payload.typ !== undefined && payload.typ !== 'access')
    ) {
      throw new SocketAuthError('not an access token');
    }
    try {
      return (await this.jwtStrategy.validate(payload)) as ValidatedUser;
    } catch {
      throw new SocketAuthError('user rejected');
    }
  }

  private async revalidate(socket: Socket) {
    const data = socket.data as SocketData;
    if (!socket.connected || !data.token) return;
    try {
      const user = await this.validateToken(data.token);
      await this.syncRooms(socket, user);
    } catch {
      socket.disconnect(true);
    }
  }

  /** Phòng = các chi nhánh user có quyền xem đơn (Super Admin: tất cả). */
  private async syncRooms(socket: Socket, user: ValidatedUser) {
    const rooms = new Set<string>([userRoom(user.id)]);

    if (user.roles?.includes(SUPER_ADMIN_ROLE)) {
      rooms.add(ORDERS_ALL_ROOM);
    } else {
      for (const branchId of user.branchIds ?? []) {
        const permissions = await this.getBranchPermissions(user.id, branchId);
        if (permissions.includes(ORDER_VIEW_PERMISSION)) {
          rooms.add(ordersBranchRoom(branchId));
        }
      }
    }

    for (const room of socket.rooms) {
      if (room !== socket.id && !rooms.has(room)) void socket.leave(room);
    }
    for (const room of rooms) void socket.join(room);
  }

  /** Giống PermissionsGuard: quyền theo chi nhánh, cache 60s. */
  private async getBranchPermissions(userId: number, branchId: number) {
    const cached = this.permissionCache.getBranch(userId, branchId);
    if (cached) return cached;
    const permissions = await this.authService.getPermissionsForBranch(
      userId,
      branchId,
    );
    this.permissionCache.setBranch(userId, branchId, permissions);
    return permissions;
  }

  /** Ngắt kết nối đúng lúc token hết hạn. */
  private scheduleExpiry(socket: Socket, token: string) {
    const decoded: AccessTokenPayload | null = this.jwtService.decode(token);
    if (!decoded?.exp) return;
    // setTimeout tối đa ~24.8 ngày; token 7 ngày nằm trong giới hạn.
    const ms = Math.min(decoded.exp * 1000 - Date.now(), 2 ** 31 - 1);
    (socket.data as SocketData).expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(ms, 0),
    );
  }

  /** Vượt giới hạn → ngắt các kết nối cũ nhất của user đó. */
  private async enforceSocketLimit(userId: number) {
    const sockets = await this.server.fetchSockets();
    const mine = sockets.filter(
      (s) => (s.data as SocketData).userId === userId,
    );
    const excess = mine.length - (MAX_SOCKETS_PER_USER - 1);
    for (let i = 0; i < excess; i++) mine[i].disconnect(true);
  }

  private clearTimers(socket: Socket) {
    const data = socket.data as SocketData;
    if (data.expiryTimer) clearTimeout(data.expiryTimer);
    if (data.revalidateTimer) clearInterval(data.revalidateTimer);
  }
}
