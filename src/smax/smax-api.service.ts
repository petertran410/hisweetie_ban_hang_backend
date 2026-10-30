import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/** Kênh (page) đã kết nối trên Smax — chỉ giữ các field POS cần. */
export interface SmaxPage {
  pid: string;
  name: string;
  // Ảnh đại diện tài khoản Zalo / OA của kênh
  picture: string | null;
  platform: string;
  active: boolean;
  /**
   * Lỗi kết nối (token Zalo hết hạn / mất phiên) — Smax ghi ở
   * members[].access_token_error; `active` vẫn true nên phải đọc riêng.
   */
  connectionError: { at: string; note: string | null } | null;
}

/** Hội thoại (thread) Zalo trên Smax — chỉ field POS cần. */
export interface SmaxThread {
  tid: string;
  name: string;
  chatType: 'private' | 'group' | string;
  /** pid → tên (thành viên nhóm / khách), để hiện người gửi. */
  members: Record<string, string>;
  /** pid → ảnh đại diện (nếu Smax có). */
  memberAvatars: Record<string, string>;
  avatar: string | null;
  memberCount: number;
  // Tối đa 4 thành viên (theo thứ tự Smax) để ghép avatar nhóm kiểu Zalo
  memberPreview: { name: string | null; avatar: string | null }[];
}

/** Tin nhắn thô Smax trả về (Partner API). */
/** Nội dung 1 lần gọi zaloweb-messages; image/images/file là URL công khai Smax tải được. */
export interface ZalowebContent {
  message?: string;
  images?: string[];
  file?: string;
  stickerId?: string;
}

export const GROUP_SCAN_LIMIT = 500;

export interface SmaxGroupThread {
  zaloId: string;
  name: string;
  // pid thành viên ("zlw" + uid), bỏ "zlw0" (bản ghi giữ chỗ của Smax)
  memberPids: string[];
  lastMessageAt: string | null;
  avatar: string | null;
  // Tối đa 4 thành viên để ghép avatar nhóm kiểu Zalo
  memberPreview: { name: string | null; avatar: string | null }[];
}

export interface SmaxRecentThread {
  tid: string;
  pagePid: string;
  name: string;
  isGroup: boolean;
  lastMessage: string;
  lastMessageAt: string | null;
  unread: boolean;
  // Tổng số tin của thread (Smax reply_count) — client tính "tin mới" theo chênh lệch
  messageCount: number;
  avatar: string | null;
  memberPreview: { name: string | null; avatar: string | null }[];
}

export interface SmaxFriendStatus {
  isFriend: boolean;
  isRequested: boolean;
  isRequesting: boolean;
}

export interface SmaxRawMessage {
  id: string;
  pid: string;
  type: string;
  message?: string;
  sender_pid?: string;
  created_at: string;
  // Chỉ API nội bộ Smax có (Partner API không trả): "deleted" = đã thu hồi; deleted.at = đã xoá phía mình
  status?: string;
  deleted?: { at?: string } | null;
  zaloweb?: {
    // Ảnh/video gửi cùng lượt (album) có chung mã này
    group_layout_id?: string;
    // Tin sticker: chỉ có mã, ảnh lấy từ máy chủ sticker công khai của Zalo
    sticker_id?: string;
    // Tin trả lời: trích tin gốc
    quote?: { global_msg_id?: string; msg?: string; reply_to_name?: string };
    // Cảm xúc theo từng người thả (icons: HEART, LIKE, HAHA, CRY…; number = số lần bấm)
    customer_reactions?: {
      customer_pid?: string;
      customer_name?: string;
      customer_picture?: string;
      icons?: { name?: string; number?: number }[];
    }[];
    attachments?: {
      url?: string;
      thumbnail?: string;
      title?: string;
      type?: string;
    }[];
  };
}

/**
 * Client Smax.AI Partner API (https://api.smax.ai, Bearer token của Business).
 * Tài liệu: https://smax.ai/api/partner/docs
 */
@Injectable()
export class SmaxApiService {
  private readonly logger = new Logger(SmaxApiService.name);
  private readonly baseUrl: string;
  readonly bizAlias: string;
  private readonly token?: string;
  // Token đăng nhập 1 tài khoản Smax (JWT) — chỉ dùng cho API nội bộ Partner API chưa có (thả cảm xúc)
  private readonly userToken?: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .get<string>('SMAX_API_URL', 'https://api.smax.ai')
      .replace(/\/+$/, '');
    this.bizAlias = config.get<string>('SMAX_BIZ_ALIAS', 'dieptra');
    this.token = config.get<string>('SMAX_API_TOKEN');
    this.userToken = config.get<string>('SMAX_USER_TOKEN')?.trim() || undefined;
  }

  /** Thả cảm xúc được không (đã cấu hình SMAX_USER_TOKEN). */
  get canReact(): boolean {
    return !!this.userToken;
  }

  /**
   * Thả / thu hồi cảm xúc tin Zalo (reaction NONE = thu hồi) qua API nội bộ của app Smax
   * (Partner API không có). Thả với tư cách tài khoản Zalo của kênh.
   */
  async reactMessage(pagePid: string, tid: string, pid: string, reaction: string): Promise<void> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa thả cảm xúc được');
    }
    await this.request(
      'POST',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages/${pid}/reaction`,
      { reaction },
      { token: this.userToken },
    );
  }

  /**
   * Thu hồi (cả 2 phía, tin của kênh, trong 24 giờ) / xoá phía mình 1 tin Zalo
   * qua API nội bộ của app Smax (Partner API không có).
   */
  async messageAction(pagePid: string, tid: string, pid: string, action: 'recall' | 'delete'): Promise<void> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa thu hồi / xoá tin được');
    }
    await this.request(
      'POST',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages/${pid}/${action}`,
      {},
      { token: this.userToken },
    );
  }

  /**
   * Trạng thái thu hồi / xoá của đúng trang tin như getMessages (cùng 20 tin, `cusor` = `before`),
   * lấy qua API nội bộ. Không có token → null.
   */
  async getMessageStates(
    pagePid: string,
    tid: string,
    before?: string,
  ): Promise<Map<string, Pick<SmaxRawMessage, 'status' | 'deleted'>> | null> {
    if (!this.userToken) return null;
    const qs = before
      ? `?${new URLSearchParams({ limit: '20', sort: '-created_at', cusor: before })}`
      : '';
    const body = await this.request(
      'GET',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages${qs}`,
      undefined,
      { allow404: true, token: this.userToken },
    );
    const rows: SmaxRawMessage[] = Array.isArray(body) ? body : (body?.data ?? []);
    return new Map(rows.map((m) => [m.pid, { status: m.status, deleted: m.deleted }]));
  }

  async listPages(): Promise<SmaxPage[]> {
    const body = await this.get(`/partner/bizs/${this.bizAlias}/pages`);
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? []);
    return rows.map((p) => ({
      pid: String(p.pid ?? p.page_pid ?? ''),
      name: p.name ?? '',
      picture: p.picture ?? p.zaloweb?.picture ?? null,
      platform: p.platform ?? '',
      active: p.active !== false,
      connectionError: this.connectionError(p),
    }));
  }

  /**
   * Kênh mất kết nối khi KHÔNG còn thành viên nào có token tốt. Zalo OA có
   * thể có nhiều admin: token cũ của 1 admin lỗi không làm kênh ngừng nếu
   * admin khác còn token hợp lệ (Smax vẫn dùng admin đó).
   */
  private connectionError(p: any): SmaxPage['connectionError'] {
    const members: any[] = Array.isArray(p.members) ? p.members : [];
    if (!members.length || members.some((m) => !m?.access_token_error)) {
      return null;
    }
    const latest = members.reduce((a, b) =>
      new Date(b.access_token_error) > new Date(a.access_token_error) ? b : a,
    );
    return {
      at: String(latest.access_token_error),
      note: latest.access_token_error_note ?? null,
    };
  }

  /**
   * Hội thoại theo tid; null nếu chưa có trên Smax. Partner API lỗi 500 với một số thread
   * (Smax "Cannot read properties of undefined (reading 'id')") → đọc lại qua API nội bộ
   * (cùng cấu trúc), không ghi log lỗi Partner mỗi lần tải tin.
   */
  async getThread(pagePid: string, tid: string): Promise<SmaxThread | null> {
    let body: any;
    try {
      body = await this.request(
        'GET',
        `/partner/bizs/${this.bizAlias}/threads/pages/${pagePid}/threads/${tid}`,
        undefined,
        { allow404: true, silent: !!this.userToken },
      );
    } catch (error) {
      if (!this.userToken) throw error;
      body = await this.request(
        'GET',
        `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}`,
        undefined,
        { allow404: true, token: this.userToken },
      );
    }
    const t = body?.data ?? body;
    if (!t?.tid) return null;
    const members: Record<string, string> = {};
    const memberAvatars: Record<string, string> = {};
    for (const c of t.customers ?? []) {
      if (c?.pid && c?.name) members[c.pid] = c.name;
      if (c?.pid && c?.picture) memberAvatars[c.pid] = c.picture;
    }
    return {
      tid: t.tid,
      name: t.customer?.name ?? t.zaloweb?.name ?? '',
      chatType: t.zaloweb?.chat_type ?? '',
      members,
      memberAvatars,
      avatar: t.customer?.picture ?? t.customer?.zaloweb?.picture ?? null,
      memberCount: (t.customer_pids ?? []).filter((p: string) => p !== 'zlw0').length,
      memberPreview: memberPreview(t),
    };
  }

  /**
   * Các nhóm Zalo kênh đang tham gia, kèm thành viên. Smax không phân trang
   * được (cursor/before bị bỏ qua) → chỉ lấy tối đa 500 nhóm có tin gần nhất.
   * Response rất nặng (~20KB/nhóm, ~15s cho 470 nhóm) — nơi gọi nên cache.
   */
  async listGroupThreads(pagePid: string): Promise<SmaxGroupThread[]> {
    const body = await this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/threads/threads`,
      { page_pids: [pagePid], is_group: 'true', limit: GROUP_SCAN_LIMIT },
      { timeout: 60000 },
    );
    return (body?.data ?? [])
      .filter((t: any) => t?.tid?.startsWith('zlw'))
      .map((t: any) => ({
        zaloId: t.tid.slice(3),
        name: t.customer?.name ?? t.customer?.zaloweb?.name ?? '',
        memberPids: (t.customer_pids ?? []).filter((p: string) => p !== 'zlw0'),
        lastMessageAt: t.last_message_at ?? null,
        avatar: t.customer?.picture ?? null,
        memberPreview: memberPreview(t),
      }));
  }

  /** Hội thoại mới nhất của các kênh (mới → cũ). Response nặng (~20KB/thread) → nơi gọi nên cache. */
  async listRecentThreads(pagePids: string[], limit = 30, keyword?: string): Promise<SmaxRecentThread[]> {
    const body = await this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/threads/threads`,
      // keyword: Smax tìm trên mọi hội thoại (tên khách/nhóm, cả thành viên & nội dung) — ~2-3s
      { page_pids: pagePids, limit, ...(keyword ? { keyword } : {}) },
      { timeout: 30000 },
    );
    return (body?.data ?? [])
      .filter((t: any) => t?.tid?.startsWith('zlw'))
      .map((t: any) => ({
        tid: t.tid,
        pagePid: t.page_pid,
        name: t.customer?.name ?? t.customer?.zaloweb?.name ?? '',
        isGroup: t.zaloweb?.chat_type === 'group' || t.customer?.zaloweb?.chat_type === 'group',
        // Tin cuối: "attach" = tệp/ảnh
        lastMessage: typeof t.message === 'string' ? t.message : '',
        lastMessageAt: t.last_message_at ?? null,
        unread: t.read === false,
        messageCount: Number(t.reply_count ?? 0),
        avatar: t.customer?.picture ?? t.customer?.zaloweb?.picture ?? null,
        memberPreview: memberPreview(t),
      }));
  }

  /** 20 tin mới nhất (Smax cố định 20/lần); `before` = created_at tin cũ nhất đã có. */
  async getMessages(
    pagePid: string,
    tid: string,
    before?: string,
  ): Promise<SmaxRawMessage[]> {
    // before = created_at (ISO) của tin cũ nhất đã có; Smax trả 20 tin trước mốc đó
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages${qs}`,
      undefined,
      { allow404: true },
    );
    return Array.isArray(body) ? body : (body?.data ?? []);
  }

  /** Gửi tin từ kênh Zalo cá nhân tới người dùng (uid) hoặc nhóm (grid). */
  async sendZaloweb(
    pagePid: string,
    to: { uid: string } | { grid: string },
    content: ZalowebContent,
  ): Promise<any> {
    return this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/zaloweb-messages`,
      { ...to, ...content },
      // Smax tự tải media từ URL rồi đẩy lên Zalo → lâu hơn tin chữ
      { timeout: content.message && Object.keys(content).length === 1 ? 15000 : 60000 },
    );
  }

  /**
   * Gửi vào thread theo tid — dùng cho TRẢ LỜI (reply_to_pid = pid tin được trả lời);
   * zaloweb-messages không có trường trích dẫn.
   */
  async sendThreadMessage(
    pagePid: string,
    tid: string,
    body: { replyToPid?: string; message: string },
  ): Promise<any> {
    return this.request('POST', `/partner/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages`, {
      ...(body.replyToPid ? { reply_to_pid: body.replyToPid } : {}),
      messages: [{ message: body.message }],
    });
  }

  /** Trạng thái kết bạn giữa kênh và người dùng Zalo (uid). */
  /**
   * Avatar bạn bè của kênh theo pid ("zlw" + uid). Link ảnh Zalo có hạn: ảnh trong
   * tin / thread của Smax hay đã hết hạn, danh sách bạn bè thì mới. Danh sách lớn (~4MB).
   */
  async listFriendAvatars(pagePid: string): Promise<Record<string, string>> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/friends`,
      undefined,
      { timeout: 30_000 },
    );
    // Smax bọc danh sách trong data.data
    let rows: any = body;
    while (rows && !Array.isArray(rows)) rows = rows.data;
    const out: Record<string, string> = {};
    for (const r of rows ?? []) if (r?.userId && r?.avatar) out[`zlw${r.userId}`] = r.avatar;
    return out;
  }

  async getFriendStatus(pagePid: string, uid: string): Promise<SmaxFriendStatus | null> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/request-friend-status?uid=${encodeURIComponent(uid)}`,
      undefined,
      { allow404: true },
    );
    const result = body?.data?.decodedData ?? body?.data;
    if (!result || (result.error_code !== undefined && result.error_code !== 0)) return null;
    const d = result.data ?? result;
    return {
      isFriend: Number(d.is_friend) === 1,
      // is_requested: kênh đã gửi lời mời cho khách; is_requesting: khách đang mời kênh
      isRequested: Number(d.is_requested) === 1,
      isRequesting: Number(d.is_requesting) === 1,
    };
  }

  /** Gửi lời mời kết bạn (Partner API không có lệnh "đồng ý" riêng). */
  async requestFriend(pagePid: string, uid: string, message: string): Promise<any> {
    return this.request('POST', `/partner/bizs/${this.bizAlias}/pages/${pagePid}/request-friend`, {
      uid,
      message,
    });
  }

  /** Thu hồi lời mời kết bạn kênh đã gửi. */
  async undoRequestFriend(pagePid: string, uid: string): Promise<any> {
    return this.request('POST', `/partner/bizs/${this.bizAlias}/pages/${pagePid}/undo-request-friend`, {
      uid,
    });
  }

  /** Tra người dùng Zalo theo SĐT từ kênh Zalo cá nhân; null nếu không thấy. */
  async findFriendByPhone(
    pagePid: string,
    phone: string,
  ): Promise<{ uid: string; name: string } | null> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/friend?phone=${encodeURIComponent(phone)}`,
      undefined,
      { allow404: true },
    );
    // Smax bọc kết quả Zalo {error_code, error_message, data}:
    // - tìm thấy: body.data = {error_code: 0, data: {uid, display_name…}}
    // - lỗi: body.data.decodedData = {error_code: 216 "User không hợp lệ"
    //   (SĐT không có Zalo / ẩn tìm theo SĐT) | 219 "SĐT không hợp lệ", …}
    const result = body?.data?.decodedData ?? body?.data;
    if (result?.error_code !== undefined && result.error_code !== 0) return null;
    const f = result?.data ?? result;
    const uid = f?.uid ?? f?.userId ?? f?.id;
    if (!uid) return null;
    return {
      uid: String(uid),
      name: f.display_name ?? f.zalo_name ?? f.zaloName ?? f.name ?? '',
    };
  }

  private async get(path: string): Promise<any> {
    return this.request('GET', path);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    data?: any,
    opts: {
      allow404?: boolean;
      timeout?: number;
      token?: string;
      silent?: boolean;
    } = {},
  ): Promise<any> {
    if (!opts.token && !this.token) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình SMAX_API_TOKEN trong .env của backend',
      );
    }
    try {
      const res = await firstValueFrom(
        this.http.request({
          method,
          url: `${this.baseUrl}${path}`,
          data,
          headers: { Authorization: `Bearer ${opts.token ?? this.token}` },
          timeout: opts.timeout ?? 15000,
        }),
      );
      return res.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404 && opts.allow404) return null;
      if (!opts.silent) {
        this.logger.error(
          `Smax ${method} ${path} lỗi ${status ?? ''}: ${JSON.stringify(
            error?.response?.data ?? error?.message,
          )}`,
        );
      }
      // 400/422: Smax/Zalo từ chối có lý do rõ (vd khách chặn tin từ người lạ) → báo đúng lý do
      const smaxMessage = error?.response?.data?.message;
      if ((status === 400 || status === 422) && typeof smaxMessage === 'string' && smaxMessage) {
        throw new BadRequestException(`Zalo: ${smaxMessage.trim()}`);
      }
      const reason =
        status === 401
          ? opts.token
            ? 'SMAX_USER_TOKEN hết hạn hoặc không hợp lệ — lấy token đăng nhập Smax mới'
            : 'token không hợp lệ hoặc đã hết hạn'
          : status === 403
            ? 'token không có quyền'
            : status === 429
              ? 'gọi API quá nhiều, thử lại sau'
              : 'không kết nối được';
      throw new BadGatewayException(`Smax: ${reason}`);
    }
  }
}

/** Tối đa 4 thành viên (tên + ảnh) của thread nhóm — ghép avatar nhóm kiểu Zalo. */
function memberPreview(t: any): { name: string | null; avatar: string | null }[] {
  return (t.customer_pids ?? [])
    .filter((p: string) => p !== 'zlw0' && p !== t.tid)
    .slice(0, 4)
    .map((p: string) => {
      const c = (t.customers ?? []).find((x: any) => x?.pid === p);
      return { name: c?.name ?? null, avatar: c?.picture ?? null };
    });
}
